import { EvolveError } from "../core/errors.js";
import type { JsonObject, Usage } from "../core/types.js";
import type { ReasoningEffort } from "../config.js";
import type {
  AgentDecision,
  AgentPrompt,
  AgentProvider,
  DecisionResult,
  FinalDecision,
  MemoryProposal,
  VerificationInput,
  VerificationResult,
  VerificationVerdict,
} from "./provider.js";

interface ResponsesOutputItem {
  type?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface ResponsesPayload {
  id?: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; code?: string };
}

const SYSTEM_INSTRUCTIONS = `You are the decision engine inside Evolve Agent, an evidence-gated autonomous runtime.
Return exactly one function call per turn. Never claim that a tool ran unless its result appears in observations.
Use the minimum necessary tool. Respect the task's requested tools, remaining budgets, and constraints.
When the task is complete, call commit_answer. Every externally checkable claim in the final answer must cite a current-episode evidence ID using [evidence:ev_...].
Do not invent evidence IDs. Do not expose hidden chain-of-thought; rationale must be a short operational reason.
Memory proposals must be durable, generalizable facts or procedures, not temporary conversation details. High-confidence memory requires evidence.`;

const VERIFIER_INSTRUCTIONS = `You are an independent acceptance verifier. Judge only the proposed answer, task criteria, and supplied evidence metadata. Do not assume missing facts. Return exactly one verification_verdict call. Pass only when the answer satisfies the goal and constraints, the evidence supports factual claims, and no material claim is unsupported. A score below 0.8 must fail.`;

function usageOf(payload: ResponsesPayload): Usage {
  const inputTokens = payload.usage?.input_tokens ?? 0;
  const outputTokens = payload.usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: payload.usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

function parseObject(value: string | undefined, label: string): Record<string, unknown> {
  if (value === undefined) throw new EvolveError("PROVIDER_PROTOCOL", `${label} omitted function arguments`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EvolveError("PROVIDER_PROTOCOL", `${label} returned invalid JSON arguments`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EvolveError("PROVIDER_PROTOCOL", `${label} arguments must be an object`);
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max = 200_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new EvolveError("PROVIDER_PROTOCOL", `${label} must be a non-empty string no longer than ${max}`);
  }
  return value;
}

function stringList(value: unknown, label: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems || !value.every((entry) => typeof entry === "string")) {
    throw new EvolveError("PROVIDER_PROTOCOL", `${label} must be an array of strings`);
  }
  return [...value];
}

function numberValue(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new EvolveError("PROVIDER_PROTOCOL", `${label} must be between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new EvolveError("PROVIDER_PROTOCOL", `${label} must be boolean`);
  return value;
}

function parseMemoryProposals(value: unknown): MemoryProposal[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3) {
    throw new EvolveError("PROVIDER_PROTOCOL", "memory_proposals must be an array of at most 3 items");
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EvolveError("PROVIDER_PROTOCOL", `memory_proposals[${index}] must be an object`);
    }
    const object = entry as Record<string, unknown>;
    return {
      text: requiredString(object.text, `memory_proposals[${index}].text`, 2_000),
      tags: stringList(object.tags, `memory_proposals[${index}].tags`, 12).map((tag) => tag.slice(0, 80)),
      confidence: numberValue(object.confidence, `memory_proposals[${index}].confidence`, 0, 1),
      evidenceIds: stringList(object.evidence_ids, `memory_proposals[${index}].evidence_ids`, 20),
    };
  });
}

export class OpenAIResponsesProvider implements AgentProvider {
  public constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      verifierModel: string;
      reasoningEffort: ReasoningEffort;
      endpoint?: string;
      timeoutMs?: number;
    },
  ) {}

  private async request(body: Record<string, unknown>): Promise<ResponsesPayload> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 180_000);
    timeout.unref();
    try {
      const response = await fetch(this.options.endpoint ?? "https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json()) as ResponsesPayload;
      if (!response.ok) {
        throw new EvolveError(
          "PROVIDER_HTTP",
          payload.error?.message ?? `OpenAI Responses API returned HTTP ${response.status}`,
          { status: response.status, code: payload.error?.code },
        );
      }
      return payload;
    } catch (error: unknown) {
      if (error instanceof EvolveError) throw error;
      if ((error as Error).name === "AbortError") throw new EvolveError("PROVIDER_TIMEOUT", "OpenAI request timed out");
      throw new EvolveError("PROVIDER_NETWORK", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  public async decide(prompt: AgentPrompt): Promise<DecisionResult> {
    const tools = prompt.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: `${tool.description} Risk classification: ${tool.risk}.`,
      parameters: tool.inputSchema,
      strict: false,
    }));
    tools.push({
      type: "function",
      name: "commit_answer",
      description: "Submit the final answer, its exact evidence set, and optional durable memory proposals.",
      parameters: {
        type: "object",
        properties: {
          answer: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
          memory_proposals: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                evidence_ids: { type: "array", items: { type: "string" } },
              },
              required: ["text", "tags", "confidence", "evidence_ids"],
              additionalProperties: false,
            },
          },
        },
        required: ["answer", "evidence_ids", "memory_proposals"],
        additionalProperties: false,
      },
      strict: true,
    });

    const payload = await this.request({
      model: this.options.model,
      store: false,
      reasoning: { effort: this.options.reasoningEffort },
      instructions: SYSTEM_INSTRUCTIONS,
      input: JSON.stringify(prompt),
      tools,
      tool_choice: "required",
      parallel_tool_calls: false,
    });
    const calls = (payload.output ?? []).filter((item) => item.type === "function_call");
    if (calls.length !== 1) {
      throw new EvolveError("PROVIDER_PROTOCOL", `Expected exactly one function call, received ${calls.length}`);
    }
    const call = calls[0] as ResponsesOutputItem;
    const parsed = parseObject(call.arguments, call.name ?? "function_call");
    let decision: AgentDecision;
    if (call.name === "commit_answer") {
      const final: FinalDecision = {
        kind: "final",
        answer: requiredString(parsed.answer, "answer"),
        evidenceIds: stringList(parsed.evidence_ids, "evidence_ids", 100),
        memoryProposals: parseMemoryProposals(parsed.memory_proposals),
      };
      decision = final;
    } else {
      const tool = prompt.tools.find((candidate) => candidate.name === call.name);
      if (!tool) throw new EvolveError("PROVIDER_PROTOCOL", `Model called unavailable tool ${String(call.name)}`);
      decision = {
        kind: "tool",
        toolName: tool.name,
        args: parsed as JsonObject,
        rationale: `Use ${tool.name} to advance the task`,
      };
    }
    return {
      decision,
      usage: usageOf(payload),
      ...(payload.id ? { providerResponseId: payload.id } : {}),
    };
  }

  public async verify(input: VerificationInput): Promise<VerificationResult> {
    const payload = await this.request({
      model: this.options.verifierModel,
      store: false,
      reasoning: { effort: this.options.reasoningEffort },
      instructions: VERIFIER_INSTRUCTIONS,
      input: JSON.stringify(input),
      tools: [
        {
          type: "function",
          name: "verification_verdict",
          description: "Return the independent acceptance verdict.",
          parameters: {
            type: "object",
            properties: {
              passed: { type: "boolean" },
              score: { type: "number", minimum: 0, maximum: 1 },
              feedback: { type: "string" },
            },
            required: ["passed", "score", "feedback"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "verification_verdict" },
      parallel_tool_calls: false,
    });
    const calls = (payload.output ?? []).filter((item) => item.type === "function_call" && item.name === "verification_verdict");
    if (calls.length !== 1) throw new EvolveError("PROVIDER_PROTOCOL", "Verifier did not return one verdict");
    const parsed = parseObject(calls[0]?.arguments, "verification_verdict");
    const score = numberValue(parsed.score, "score", 0, 1);
    const passed = booleanValue(parsed.passed, "passed") && score >= 0.8;
    const verdict: VerificationVerdict = {
      passed,
      score,
      feedback: requiredString(parsed.feedback, "feedback", 4_000),
    };
    return {
      verdict,
      usage: usageOf(payload),
      ...(payload.id ? { providerResponseId: payload.id } : {}),
    };
  }
}
