import { performance } from "node:perf_hooks";
import { sha256Json } from "../core/hash.js";
import type { EvidenceRecord, SkillRecord, Usage } from "../core/types.js";
import type { AgentPrompt, AgentProvider, Observation } from "../providers/provider.js";
import type { ToolDescription } from "../tools/types.js";
import type { ReplayHarnessInput, ReplayRunResult } from "./types.js";

const EVIDENCE_PATTERN = /ev_[a-f0-9]{24}/g;

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function failure(
  input: ReplayHarnessInput,
  startedAt: number,
  usage: Usage,
  turns: number,
  toolCalls: number,
  reason: string,
  safetyViolations: string[] = [],
): ReplayRunResult {
  return {
    fixtureId: input.fixture.id,
    fixtureHash: input.fixture.integrityHash,
    sourceEpisodeId: input.fixture.sourceEpisodeId,
    arm: input.arm,
    repeat: input.repeat,
    success: false,
    verifierScore: 0,
    usage,
    turns,
    toolCalls,
    durationMs: Math.max(0, performance.now() - startedAt),
    traceMatched: false,
    failureReason: reason,
    safetyViolations,
    activeSkillIds: input.skills.map((skill) => skill.id).sort(),
  };
}

export class ReplayHarness {
  public constructor(
    private readonly provider: AgentProvider,
    private readonly tools: ToolDescription[],
  ) {}

  public async run(input: ReplayHarnessInput): Promise<ReplayRunResult> {
    const startedAt = performance.now();
    const observations: Observation[] = [];
    const permittedEvidence = new Map<string, EvidenceRecord>();
    let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let turns = 0;
    let toolCalls = 0;
    let traceIndex = 0;
    const maxTurns = Math.max(1, input.fixture.task.budget.maxTurns);
    const selectedTools = this.tools.filter((tool) => input.fixture.task.requestedTools.includes(tool.name));

    while (turns < maxTurns) {
      const prompt: AgentPrompt = {
        task: input.fixture.task,
        observations: observations.slice(-20),
        memories: [],
        skills: input.skills,
        tools: selectedTools,
        remainingBudget: {
          turns: maxTurns - turns,
          toolCalls: Math.max(0, input.fixture.task.budget.maxToolCalls - toolCalls),
          inputTokens: Math.max(0, input.fixture.task.budget.maxInputTokens - usage.inputTokens),
          outputTokens: Math.max(0, input.fixture.task.budget.maxOutputTokens - usage.outputTokens),
          wallTimeMs: input.fixture.task.budget.maxWallTimeMs,
        },
      };
      const decisionResult = await this.provider.decide(prompt);
      turns += 1;
      usage = addUsage(usage, decisionResult.usage);

      if (decisionResult.decision.kind === "tool") {
        const decision = decisionResult.decision;
        const expected = input.fixture.trace[traceIndex];
        if (!expected) {
          return failure(input, startedAt, usage, turns, toolCalls, `Unexpected extra tool ${decision.toolName}`, [
            "unexpected_tool",
          ]);
        }
        const argsHash = sha256Json(decision.args);
        if (decision.toolName !== expected.toolName || argsHash !== expected.argsHash) {
          return failure(
            input,
            startedAt,
            usage,
            turns,
            toolCalls,
            `Trace mismatch at step ${traceIndex}: expected ${expected.toolName}/${expected.argsHash}, received ${decision.toolName}/${argsHash}`,
            ["trace_mismatch"],
          );
        }
        toolCalls += 1;
        traceIndex += 1;
        permittedEvidence.set(expected.evidence.id, expected.evidence);
        observations.push({
          id: `replay_${input.fixture.id}_${traceIndex}`,
          kind: expected.success ? "tool" : "error",
          content: expected.observation,
          evidenceId: expected.evidence.id,
          toolName: expected.toolName,
        });
        continue;
      }

      const final = decisionResult.decision;
      if (traceIndex !== input.fixture.trace.length) {
        return failure(
          input,
          startedAt,
          usage,
          turns,
          toolCalls,
          `Final answer arrived before replay trace completed (${traceIndex}/${input.fixture.trace.length})`,
          ["incomplete_trace"],
        );
      }
      const declared = [...new Set(final.evidenceIds)];
      const invalid = declared.filter((id) => !permittedEvidence.has(id));
      if (invalid.length > 0) {
        return failure(input, startedAt, usage, turns, toolCalls, `Final answer declared unavailable evidence: ${invalid.join(", ")}`, [
          "fabricated_evidence",
        ]);
      }
      const cited = [...new Set(final.answer.match(EVIDENCE_PATTERN) ?? [])];
      const undeclared = cited.filter((id) => !declared.includes(id));
      if (undeclared.length > 0 || (declared.length > 0 && cited.length === 0)) {
        return failure(input, startedAt, usage, turns, toolCalls, "Final answer evidence declaration and citations disagree", [
          "evidence_contract",
        ]);
      }
      const evidence = declared.map((id) => permittedEvidence.get(id)).filter((record): record is EvidenceRecord => Boolean(record));
      const verification = await this.provider.verify({ task: input.fixture.task, answer: final.answer, evidence });
      usage = addUsage(usage, verification.usage);
      const success = verification.verdict.passed && verification.verdict.score >= 0.8;
      return {
        fixtureId: input.fixture.id,
        fixtureHash: input.fixture.integrityHash,
        sourceEpisodeId: input.fixture.sourceEpisodeId,
        arm: input.arm,
        repeat: input.repeat,
        success,
        verifierScore: verification.verdict.score,
        usage,
        turns,
        toolCalls,
        durationMs: Math.max(0, performance.now() - startedAt),
        traceMatched: true,
        ...(!success ? { failureReason: verification.verdict.feedback } : {}),
        safetyViolations: [],
        activeSkillIds: input.skills.map((skill) => skill.id).sort(),
      };
    }

    return failure(input, startedAt, usage, turns, toolCalls, `Replay exhausted ${maxTurns} turns`, ["turn_budget"]);
  }

  public static actualBaseline(input: {
    fixtureId: string;
    fixtureHash: string;
    sourceEpisodeId: string;
    repeat?: number;
    verifierScore: number;
    usage: Usage;
    turns: number;
    toolCalls: number;
    durationMs: number;
    activeSkillIds: string[];
    arm: "baseline" | "candidate";
    success?: boolean;
    failureReason?: string;
  }): ReplayRunResult {
    return {
      fixtureId: input.fixtureId,
      fixtureHash: input.fixtureHash,
      sourceEpisodeId: input.sourceEpisodeId,
      arm: input.arm,
      repeat: input.repeat ?? 0,
      success: input.success ?? true,
      verifierScore: input.verifierScore,
      usage: input.usage,
      turns: input.turns,
      toolCalls: input.toolCalls,
      durationMs: input.durationMs,
      traceMatched: true,
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      safetyViolations: [],
      activeSkillIds: [...input.activeSkillIds].sort(),
    };
  }
}
