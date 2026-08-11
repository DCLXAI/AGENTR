import { sha256Json } from "../src/core/hash.js";
import type { SkillRecord, Usage } from "../src/core/types.js";
import type {
  AgentPrompt,
  AgentProvider,
  DecisionResult,
  VerificationInput,
  VerificationResult,
} from "../src/providers/provider.js";
import type { ReplayFixturePayload } from "../src/evaluation/types.js";

export class SkillAwareProvider implements AgentProvider {
  public readonly prompts: AgentPrompt[] = [];
  public readonly verifications: VerificationInput[] = [];

  public constructor(public candidateSkillId: string) {}

  public async decide(prompt: AgentPrompt): Promise<DecisionResult> {
    this.prompts.push(prompt);
    const candidate = prompt.skills.some((skill) => skill.id === this.candidateSkillId);
    const usage: Usage = candidate
      ? { inputTokens: 7, outputTokens: 3, totalTokens: 10 }
      : { inputTokens: 12, outputTokens: 8, totalTokens: 20 };
    if (prompt.observations.length === 0) {
      const path = prompt.task.goal.match(/file-\d+\.txt/)?.[0] ?? "file-0.txt";
      return {
        decision: { kind: "tool", toolName: "read_file", args: { path }, rationale: "Replay the recorded read" },
        usage,
      };
    }
    const evidence = prompt.observations.findLast((observation) => observation.evidenceId)?.evidenceId;
    if (!evidence) throw new Error("Expected replay evidence");
    return {
      decision: {
        kind: "final",
        answer: `${candidate ? "Candidate" : "Baseline"} answer [evidence:${evidence}]`,
        evidenceIds: [evidence],
        memoryProposals: [],
      },
      usage,
    };
  }

  public async verify(input: VerificationInput): Promise<VerificationResult> {
    this.verifications.push(input);
    const candidate = input.answer.startsWith("Candidate");
    return {
      verdict: {
        passed: true,
        score: candidate ? 0.96 : 0.82,
        feedback: candidate ? "candidate accepted" : "baseline accepted",
      },
      usage: candidate
        ? { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
        : { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
    };
  }
}

export function candidateInput(index = 0): {
  fingerprint: string;
  name: string;
  description: string;
  triggers: string[];
  steps: Array<{ toolName: string; purpose: string }>;
  allowedTools: string[];
  supportingEpisodes: string[];
  provenanceEvidenceIds: string[];
} {
  const suffix = index.toString(16).padStart(2, "0");
  return {
    fingerprint: `${suffix}${"a".repeat(62)}`,
    name: "Read one file accurately",
    description: "Use read_file and produce an evidence-backed answer with less deliberation.",
    triggers: ["inspect", "file"],
    steps: [{ toolName: "read_file", purpose: "Read the requested file" }],
    allowedTools: ["read_file"],
    supportingEpisodes: ["ep_aaaaaaaaaaaaaaaaaaaaaaaa", "ep_bbbbbbbbbbbbbbbbbbbbbbbb"],
    provenanceEvidenceIds: ["ev_aaaaaaaaaaaaaaaaaaaaaaaa", "ev_bbbbbbbbbbbbbbbbbbbbbbbb"],
  };
}

export function fixturePayload(index: number, activeSkillIds: string[] = []): ReplayFixturePayload {
  const hex = index.toString(16).padStart(24, "0").slice(-24);
  const episodeId = `ep_${hex}`;
  const evidenceId = `ev_${(index + 100).toString(16).padStart(24, "0").slice(-24)}`;
  const file = `file-${index}.txt`;
  const args = { path: file };
  return {
    version: 1,
    sourceEpisodeId: episodeId,
    split: index % 2 === 0 ? "validation" : "holdout",
    createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    task: {
      id: `task_${(index + 200).toString(16).padStart(24, "0").slice(-24)}`,
      goal: `Inspect ${file} and report the result.`,
      constraints: ["Use replay evidence"],
      successCriteria: ["Answer cites the read evidence"],
      requestedTools: ["read_file"],
      budget: {
        maxTurns: 4,
        maxToolCalls: 2,
        maxInputTokens: 20_000,
        maxOutputTokens: 5_000,
        maxWallTimeMs: 60_000,
      },
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
    },
    trace: [
      {
        index: 0,
        toolName: "read_file",
        argsHash: sha256Json(args),
        evidence: {
          id: evidenceId,
          episodeId,
          toolName: "read_file",
          argsHash: sha256Json(args),
          artifactHash: sha256Json({ file, content: `value-${index}` }),
          summary: `${file} contains value-${index}`,
          success: true,
          createdAt: new Date(1_700_000_000_000 + index).toISOString(),
        },
        observation: `${file} contains value-${index} [evidence:${evidenceId}]`,
        success: true,
      },
    ],
    baseline: {
      status: "committed",
      answerHash: sha256Json(`Baseline answer ${index}`),
      verifierScore: 0.82,
      usage: { inputTokens: 29, outputTokens: 19, totalTokens: 48 },
      turns: 2,
      toolCalls: 1,
      elapsedMs: 100,
      activeSkillIds,
    },
  };
}

export function asSkill(record: SkillRecord): SkillRecord {
  return record;
}
