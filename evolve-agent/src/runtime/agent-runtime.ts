import { randomUUID } from "node:crypto";
import { errorMessage, EvolveError } from "../core/errors.js";
import { sha256Json } from "../core/hash.js";
import type { EpisodeCheckpoint, RunResult, TaskBudget, TaskInput, TaskSpec, Usage } from "../core/types.js";
import type { JsonlLedger } from "../ledger/jsonl-ledger.js";
import type { ArtifactStore } from "../ledger/artifact-store.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { Approver } from "../policy/approver.js";
import type { CapabilityAuthority } from "../policy/capability.js";
import type { RiskEngine } from "../policy/risk-engine.js";
import type { AgentProvider, Observation } from "../providers/provider.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { LearningEngine } from "../learning/learning-engine.js";
import type { ContextCompiler } from "../context/context-compiler.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { FinalVerifier } from "../verification/final-verifier.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { EpisodeLease, EpisodeLeaseManager } from "./lease-manager.js";

const DEFAULT_BUDGET: TaskBudget = {
  maxTurns: 12,
  maxToolCalls: 8,
  maxInputTokens: 200_000,
  maxOutputTokens: 40_000,
  maxWallTimeMs: 5 * 60_000,
};

function episodeId(): string {
  return `ep_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function observationId(): string {
  return `obs_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function resultOf(checkpoint: EpisodeCheckpoint): RunResult {
  return {
    episodeId: checkpoint.episodeId,
    status: checkpoint.status,
    ...(checkpoint.answer !== undefined ? { answer: checkpoint.answer } : {}),
    evidenceIds: checkpoint.evidenceIds,
    usage: checkpoint.usage,
    turns: checkpoint.turns,
    toolCalls: checkpoint.toolCalls,
    ...(checkpoint.stopReason !== undefined ? { reason: checkpoint.stopReason } : {}),
  };
}

function preTurnBudgetReason(checkpoint: EpisodeCheckpoint): string | undefined {
  const budget = checkpoint.task.budget;
  if (checkpoint.turns >= budget.maxTurns) return `Turn budget exhausted (${budget.maxTurns})`;
  if (checkpoint.usage.inputTokens >= budget.maxInputTokens) return `Input-token budget exhausted (${budget.maxInputTokens})`;
  if (checkpoint.usage.outputTokens >= budget.maxOutputTokens) return `Output-token budget exhausted (${budget.maxOutputTokens})`;
  if (checkpoint.elapsedMs >= budget.maxWallTimeMs) return `Wall-time budget exhausted (${budget.maxWallTimeMs} ms)`;
  return undefined;
}

function hardOverrunReason(checkpoint: EpisodeCheckpoint): string | undefined {
  const budget = checkpoint.task.budget;
  if (checkpoint.usage.inputTokens > budget.maxInputTokens) return `Input-token budget exceeded (${budget.maxInputTokens})`;
  if (checkpoint.usage.outputTokens > budget.maxOutputTokens) return `Output-token budget exceeded (${budget.maxOutputTokens})`;
  if (checkpoint.elapsedMs > budget.maxWallTimeMs) return `Wall-time budget exceeded (${budget.maxWallTimeMs} ms)`;
  return undefined;
}

export interface RuntimeDependencies {
  provider: AgentProvider;
  ledger: JsonlLedger;
  artifacts: ArtifactStore;
  checkpoints: CheckpointStore;
  tools: ToolRegistry;
  risk: RiskEngine;
  approver: Approver;
  capabilities: CapabilityAuthority;
  context: ContextCompiler;
  verifier: FinalVerifier;
  memory: MemoryStore;
  skills: SkillStore;
  learning: LearningEngine;
  leases: EpisodeLeaseManager;
}

export class AgentRuntime {
  public constructor(private readonly dependencies: RuntimeDependencies) {}

  private createTask(input: TaskInput): TaskSpec {
    const goal = input.goal.trim();
    if (goal.length < 3 || goal.length > 20_000) throw new EvolveError("TASK_INVALID", "Goal length is invalid");
    const requestedTools = [...new Set(input.requestedTools ?? this.dependencies.tools.readOnlyNames())];
    const unknown = requestedTools.filter((name) => !this.dependencies.tools.has(name));
    if (unknown.length > 0) throw new EvolveError("TASK_TOOL_UNKNOWN", `Unknown requested tools: ${unknown.join(", ")}`);
    const budget: TaskBudget = { ...DEFAULT_BUDGET, ...(input.budget ?? {}) };
    for (const [key, value] of Object.entries(budget)) {
      if (!Number.isFinite(value) || value <= 0) throw new EvolveError("TASK_BUDGET_INVALID", `${key} must be positive`);
    }
    return {
      id: `task_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      goal,
      constraints: [...new Set((input.constraints ?? []).map((value) => value.trim()).filter(Boolean))].slice(0, 50),
      successCriteria: [...new Set((input.successCriteria ?? ["The answer satisfies the stated goal without unsupported factual claims"]).map((value) => value.trim()).filter(Boolean))].slice(0, 50),
      requestedTools,
      budget,
      createdAt: new Date().toISOString(),
    };
  }

  public async run(input: TaskInput): Promise<RunResult> {
    const task = this.createTask(input);
    const checkpoint: EpisodeCheckpoint = {
      version: 1,
      episodeId: episodeId(),
      task,
      status: "running",
      observations: [],
      evidenceIds: [],
      toolSequence: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: 0,
      toolCalls: 0,
      elapsedMs: 0,
      updatedAt: new Date().toISOString(),
    };
    return this.dependencies.leases.withLease(checkpoint.episodeId, async (lease) => {
      await this.dependencies.ledger.append(checkpoint.episodeId, "episode.started", {
        task_id: task.id,
        goal_hash: sha256Json(task.goal),
        requested_tools: task.requestedTools,
        budget: {
          max_turns: task.budget.maxTurns,
          max_tool_calls: task.budget.maxToolCalls,
          max_input_tokens: task.budget.maxInputTokens,
          max_output_tokens: task.budget.maxOutputTokens,
          max_wall_time_ms: task.budget.maxWallTimeMs,
        },
      });
      await this.recordLease(checkpoint.episodeId, lease, "run");
      await this.dependencies.checkpoints.save(checkpoint);
      return this.execute(checkpoint, false);
    });
  }

  public async resume(episode: string): Promise<RunResult> {
    return this.dependencies.leases.withLease(episode, async (lease) => {
      const checkpoint = await this.dependencies.checkpoints.load(episode);
      if (checkpoint.status === "committed" || checkpoint.status === "budget_exhausted") {
        throw new EvolveError("EPISODE_TERMINAL", `Cannot resume ${checkpoint.status} episode ${episode}`);
      }
      await this.recordLease(episode, lease, "resume");
      checkpoint.status = "running";
      delete checkpoint.stopReason;
      await this.dependencies.ledger.append(episode, "episode.resumed", {
        turns: checkpoint.turns,
        tool_calls: checkpoint.toolCalls,
        elapsed_ms: checkpoint.elapsedMs,
      });
      await this.dependencies.checkpoints.save(checkpoint);
      return this.execute(checkpoint, true);
    });
  }

  private async recordLease(episode: string, lease: EpisodeLease, phase: "run" | "resume"): Promise<void> {
    await this.dependencies.ledger.append(episode, "episode.lease_acquired", {
      phase,
      owner_id: lease.ownerId,
    });
    if (lease.recovered) {
      await this.dependencies.ledger.append(episode, "episode.stale_lock_recovered", {
        previous_owner_id: lease.recovered.ownerId,
        previous_pid: lease.recovered.pid,
        previous_acquired_at: lease.recovered.acquiredAt,
      });
    }
  }

  private async stopForBudget(checkpoint: EpisodeCheckpoint, reason: string): Promise<RunResult> {
    checkpoint.status = "budget_exhausted";
    checkpoint.stopReason = reason;
    await this.dependencies.ledger.append(checkpoint.episodeId, "episode.budget_exhausted", {
      reason,
      turns: checkpoint.turns,
      tool_calls: checkpoint.toolCalls,
      usage: {
        input_tokens: checkpoint.usage.inputTokens,
        output_tokens: checkpoint.usage.outputTokens,
        total_tokens: checkpoint.usage.totalTokens,
      },
      elapsed_ms: checkpoint.elapsedMs,
    });
    await this.dependencies.checkpoints.save(checkpoint);
    return resultOf(checkpoint);
  }

  private async execute(checkpoint: EpisodeCheckpoint, resumed: boolean): Promise<RunResult> {
    const segmentStartedAt = Date.now();
    const elapsedBeforeSegment = checkpoint.elapsedMs;
    const updateElapsed = (): void => {
      checkpoint.elapsedMs = elapsedBeforeSegment + (Date.now() - segmentStartedAt);
    };

    try {
      while (checkpoint.status === "running") {
        updateElapsed();
        const preReason = preTurnBudgetReason(checkpoint);
        if (preReason) return this.stopForBudget(checkpoint, preReason);

        const prompt = await this.dependencies.context.compile({
          task: checkpoint.task,
          observations: checkpoint.observations as Observation[],
          usage: checkpoint.usage,
          turns: checkpoint.turns,
          toolCalls: checkpoint.toolCalls,
          elapsedMs: checkpoint.elapsedMs,
        });
        const decisionResult = await this.dependencies.provider.decide(prompt);
        checkpoint.turns += 1;
        checkpoint.usage = addUsage(checkpoint.usage, decisionResult.usage);
        updateElapsed();

        if (decisionResult.decision.kind === "tool") {
          const decision = decisionResult.decision;
          if (checkpoint.toolCalls >= checkpoint.task.budget.maxToolCalls) {
            return this.stopForBudget(
              checkpoint,
              `Tool-call budget exhausted (${checkpoint.task.budget.maxToolCalls})`,
            );
          }
          await this.dependencies.ledger.append(checkpoint.episodeId, "model.tool_proposed", {
            turn: checkpoint.turns,
            tool: decision.toolName,
            args_hash: sha256Json(decision.args),
            ...(decisionResult.providerResponseId ? { provider_response_id: decisionResult.providerResponseId } : {}),
          });

          const tool = this.dependencies.tools.get(decision.toolName);
          let validatedArgs: Record<string, unknown>;
          try {
            validatedArgs = tool.validate(decision.args);
          } catch (error: unknown) {
            checkpoint.observations.push({
              id: observationId(),
              kind: "error",
              toolName: decision.toolName,
              content: `Tool arguments rejected: ${errorMessage(error)}`,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, "tool.arguments_rejected", {
              tool: decision.toolName,
              error: errorMessage(error),
            });
            await this.dependencies.checkpoints.save(checkpoint);
            continue;
          }

          const policy = this.dependencies.risk.evaluate(checkpoint.task, tool, validatedArgs);
          if (!policy.allowed) {
            checkpoint.observations.push({
              id: observationId(),
              kind: "error",
              toolName: decision.toolName,
              content: `Policy denied tool call: ${policy.reason}`,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, "tool.policy_denied", {
              tool: decision.toolName,
              reason: policy.reason,
            });
            await this.dependencies.checkpoints.save(checkpoint);
            continue;
          }

          if (policy.approvalRequired) {
            const approved = await this.dependencies.approver.approve({
              episodeId: checkpoint.episodeId,
              toolName: decision.toolName,
              risk: tool.risk as "write" | "execute" | "external",
              args: validatedArgs,
              reason: policy.reason,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, approved ? "approval.granted" : "approval.denied", {
              tool: decision.toolName,
              args_hash: sha256Json(validatedArgs),
            });
            if (!approved) {
              checkpoint.observations.push({
                id: observationId(),
                kind: "error",
                toolName: decision.toolName,
                content: "Human approval was denied. Choose a safer action or explain the limitation.",
              });
              await this.dependencies.checkpoints.save(checkpoint);
              continue;
            }
          }

          const capabilityToken = await this.dependencies.capabilities.issue({
            episodeId: checkpoint.episodeId,
            toolName: decision.toolName,
            args: validatedArgs,
          });
          checkpoint.toolCalls += 1;
          let evidence;
          try {
            const { execution } = await this.dependencies.tools.execute({
              episodeId: checkpoint.episodeId,
              toolName: decision.toolName,
              rawArgs: validatedArgs,
              capabilityToken,
            });
            evidence = await this.dependencies.artifacts.put({
              episodeId: checkpoint.episodeId,
              toolName: decision.toolName,
              args: validatedArgs,
              data: execution.data,
              summary: execution.summary,
              success: execution.success,
            });
            checkpoint.evidenceIds.push(evidence.id);
            if (execution.success) checkpoint.toolSequence.push(decision.toolName);
            checkpoint.observations.push({
              id: observationId(),
              kind: execution.success ? "tool" : "error",
              toolName: decision.toolName,
              evidenceId: evidence.id,
              content: `${execution.summary} [evidence:${evidence.id}]`,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, "tool.executed", {
              tool: decision.toolName,
              success: execution.success,
              evidence_id: evidence.id,
              artifact_hash: evidence.artifactHash,
              args_hash: evidence.argsHash,
            });
          } catch (error: unknown) {
            evidence = await this.dependencies.artifacts.put({
              episodeId: checkpoint.episodeId,
              toolName: decision.toolName,
              args: validatedArgs,
              data: { error: errorMessage(error) },
              summary: `${decision.toolName} failed: ${errorMessage(error)}`,
              success: false,
            });
            checkpoint.evidenceIds.push(evidence.id);
            checkpoint.observations.push({
              id: observationId(),
              kind: "error",
              toolName: decision.toolName,
              evidenceId: evidence.id,
              content: `${decision.toolName} failed: ${errorMessage(error)} [evidence:${evidence.id}]`,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, "tool.failed", {
              tool: decision.toolName,
              evidence_id: evidence.id,
              error: errorMessage(error),
            });
          }
          updateElapsed();
          await this.dependencies.checkpoints.save(checkpoint);
          continue;
        }

        const decision = decisionResult.decision;
        await this.dependencies.ledger.append(checkpoint.episodeId, "model.final_proposed", {
          turn: checkpoint.turns,
          answer_hash: sha256Json(decision.answer),
          evidence_ids: decision.evidenceIds,
          ...(decisionResult.providerResponseId ? { provider_response_id: decisionResult.providerResponseId } : {}),
        });
        const verification = await this.dependencies.verifier.verify(checkpoint.episodeId, checkpoint.task, decision);
        checkpoint.usage = addUsage(checkpoint.usage, verification.usage);
        updateElapsed();

        const postReason = hardOverrunReason(checkpoint);
        if (postReason) return this.stopForBudget(checkpoint, postReason);

        if (!verification.passed) {
          checkpoint.observations.push({
            id: observationId(),
            kind: "verification",
            content: `Final answer rejected (score ${verification.verdict.score.toFixed(2)}): ${verification.verdict.feedback}`,
          });
          await this.dependencies.ledger.append(checkpoint.episodeId, "verification.rejected", {
            score: verification.verdict.score,
            feedback: verification.verdict.feedback,
          });
          await this.dependencies.checkpoints.save(checkpoint);
          continue;
        }

        checkpoint.answer = decision.answer;
        checkpoint.status = "committed";
        const validEvidence = new Set(verification.validEvidenceIds);
        for (const proposal of decision.memoryProposals) {
          try {
            const memory = await this.dependencies.memory.add({
              text: proposal.text,
              tags: proposal.tags,
              confidence: proposal.confidence,
              sourceEpisodeId: checkpoint.episodeId,
              evidenceIds: proposal.evidenceIds,
              validEvidenceIds: validEvidence,
            });
            await this.dependencies.ledger.append(checkpoint.episodeId, "memory.accepted", {
              memory_id: memory.id,
              evidence_ids: memory.evidenceIds,
              confidence: memory.confidence,
            });
          } catch (error: unknown) {
            await this.dependencies.ledger.append(checkpoint.episodeId, "memory.rejected", {
              reason: errorMessage(error),
              text_hash: sha256Json(proposal.text),
            });
          }
        }

        await this.dependencies.ledger.append(checkpoint.episodeId, "episode.committed", {
          answer_hash: sha256Json(decision.answer),
          evidence_ids: verification.validEvidenceIds,
          score: verification.verdict.score,
          turns: checkpoint.turns,
          tool_calls: checkpoint.toolCalls,
          usage: {
            input_tokens: checkpoint.usage.inputTokens,
            output_tokens: checkpoint.usage.outputTokens,
            total_tokens: checkpoint.usage.totalTokens,
          },
          resumed,
        });
        await this.dependencies.checkpoints.save(checkpoint);
        await this.dependencies.learning.observeCommitted(checkpoint);
        return resultOf(checkpoint);
      }
      return resultOf(checkpoint);
    } catch (error: unknown) {
      updateElapsed();
      const isProviderInterruption =
        error instanceof EvolveError && ["PROVIDER_AUTH", "PROVIDER_HTTP", "PROVIDER_TIMEOUT", "PROVIDER_NETWORK"].includes(error.code);
      checkpoint.status = isProviderInterruption ? "interrupted" : "failed";
      checkpoint.stopReason = errorMessage(error);
      await this.dependencies.ledger.append(checkpoint.episodeId, isProviderInterruption ? "episode.interrupted" : "episode.failed", {
        reason: checkpoint.stopReason,
        turns: checkpoint.turns,
        tool_calls: checkpoint.toolCalls,
      });
      await this.dependencies.checkpoints.save(checkpoint);
      return resultOf(checkpoint);
    }
  }
}
