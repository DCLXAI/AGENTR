import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, ensureDir, readJsonFile } from "../core/fs.js";
import { sha256Json } from "../core/hash.js";
import type { JsonObject, JsonValue, LedgerEvent } from "../core/types.js";
import { EvolveError } from "../core/errors.js";
import type { ArtifactStore } from "../ledger/artifact-store.js";
import type { JsonlLedger } from "../ledger/jsonl-ledger.js";
import type { CheckpointStore } from "../runtime/checkpoint-store.js";
import type { FixtureSplit, ReplayFixture, ReplayFixturePayload, ReplayTraceStep } from "./types.js";

const FIXTURE_ID = /^fixture_[a-f0-9]{24}$/;

function objectValue(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new EvolveError("FIXTURE_EVENT", "Ledger event payload is not an object");
  }
  return value;
}

function requiredString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new EvolveError("FIXTURE_EVENT", `Ledger event omitted ${key}`);
  }
  return value;
}

function numberValue(object: JsonObject, key: string, fallback = 0): number {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function splitFor(sourceEpisodeId: string): FixtureSplit {
  const bucket = Number.parseInt(sha256Json(sourceEpisodeId).slice(0, 8), 16) % 10;
  if (bucket >= 8) return "holdout";
  if (bucket >= 6) return "validation";
  return "train";
}


function validatePayload(payload: ReplayFixturePayload): void {
  if (payload.version !== 1) throw new EvolveError("FIXTURE_FORMAT", "Unsupported fixture version");
  if (!/^ep_[a-f0-9]{24}$/.test(payload.sourceEpisodeId)) {
    throw new EvolveError("FIXTURE_FORMAT", "Fixture source Episode ID is invalid");
  }
  if (!["train", "validation", "holdout"].includes(payload.split)) {
    throw new EvolveError("FIXTURE_FORMAT", "Fixture split is invalid");
  }
  if (!payload.task || typeof payload.task.goal !== "string" || payload.task.goal.length < 3) {
    throw new EvolveError("FIXTURE_FORMAT", "Fixture task is invalid");
  }
  if (!Array.isArray(payload.trace) || payload.trace.length > payload.task.budget.maxToolCalls) {
    throw new EvolveError("FIXTURE_FORMAT", "Fixture trace exceeds its tool-call budget");
  }
  for (const [index, step] of payload.trace.entries()) {
    if (step.index !== index || !/^[a-f0-9]{64}$/.test(step.argsHash)) {
      throw new EvolveError("FIXTURE_FORMAT", `Fixture trace step ${index} is malformed`);
    }
    if (!/^ev_[a-f0-9]{24}$/.test(step.evidence.id) || step.evidence.episodeId !== payload.sourceEpisodeId) {
      throw new EvolveError("FIXTURE_FORMAT", `Fixture trace step ${index} has invalid evidence provenance`);
    }
    if (step.evidence.toolName !== step.toolName || !/^[a-f0-9]{64}$/.test(step.evidence.argsHash)) {
      throw new EvolveError("FIXTURE_FORMAT", `Fixture trace step ${index} evidence does not match the action`);
    }
    if (!/^[a-f0-9]{64}$/.test(step.evidence.artifactHash)) {
      throw new EvolveError("FIXTURE_FORMAT", `Fixture trace step ${index} artifact hash is invalid`);
    }
  }
  if (payload.baseline.status !== "committed" || payload.baseline.verifierScore < 0 || payload.baseline.verifierScore > 1) {
    throw new EvolveError("FIXTURE_FORMAT", "Fixture baseline is invalid");
  }
}

function payloadOf(fixture: ReplayFixture): ReplayFixturePayload {
  const { id: _id, integrityHash: _integrityHash, ...payload } = fixture;
  return payload;
}

export class FixtureStore {
  private readonly directory: string;

  public constructor(
    home: string,
    private readonly checkpoints: CheckpointStore,
    private readonly ledger: JsonlLedger,
    private readonly artifacts: ArtifactStore,
  ) {
    this.directory = path.join(home, "evaluations", "fixtures");
  }

  private pathFor(id: string): string {
    if (!FIXTURE_ID.test(id)) throw new EvolveError("FIXTURE_ID", `Invalid fixture ID: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  public verify(fixture: ReplayFixture): boolean {
    const integrityHash = sha256Json(payloadOf(fixture));
    return fixture.integrityHash === integrityHash && fixture.id === `fixture_${integrityHash.slice(0, 24)}`;
  }

  public async put(payload: ReplayFixturePayload): Promise<ReplayFixture> {
    validatePayload(payload);
    const normalized: ReplayFixturePayload = {
      ...payload,
      task: {
        ...payload.task,
        constraints: [...payload.task.constraints],
        successCriteria: [...payload.task.successCriteria],
        requestedTools: [...payload.task.requestedTools],
        budget: { ...payload.task.budget },
      },
      trace: payload.trace.map((step, index) => ({
        ...step,
        index,
        evidence: { ...step.evidence },
      })),
      baseline: {
        ...payload.baseline,
        usage: { ...payload.baseline.usage },
        activeSkillIds: [...new Set(payload.baseline.activeSkillIds)].sort(),
      },
    };
    const integrityHash = sha256Json(normalized);
    const fixture: ReplayFixture = {
      ...normalized,
      id: `fixture_${integrityHash.slice(0, 24)}`,
      integrityHash,
    };
    await atomicWriteJson(this.pathFor(fixture.id), fixture, 0o600);
    return fixture;
  }

  public async import(value: unknown): Promise<ReplayFixture> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new EvolveError("FIXTURE_IMPORT", "Fixture import must be an object");
    }
    const candidate = value as Partial<ReplayFixture>;
    if (candidate.version !== 1 || !candidate.sourceEpisodeId || !candidate.task || !candidate.baseline || !candidate.trace) {
      throw new EvolveError("FIXTURE_IMPORT", "Fixture import is missing required fields");
    }
    const payload: ReplayFixturePayload = {
      version: 1,
      sourceEpisodeId: candidate.sourceEpisodeId,
      split: candidate.split ?? splitFor(candidate.sourceEpisodeId),
      createdAt: candidate.createdAt ?? new Date().toISOString(),
      task: candidate.task,
      trace: candidate.trace,
      baseline: candidate.baseline,
    };
    return this.put(payload);
  }

  public async get(id: string): Promise<ReplayFixture> {
    const fixture = await readJsonFile<ReplayFixture | null>(this.pathFor(id), null);
    if (!fixture) throw new EvolveError("FIXTURE_NOT_FOUND", `Unknown fixture: ${id}`);
    if (!this.verify(fixture)) throw new EvolveError("FIXTURE_TAMPERED", `Fixture integrity check failed: ${id}`);
    return fixture;
  }

  public async list(splits?: Set<FixtureSplit>): Promise<ReplayFixture[]> {
    await ensureDir(this.directory);
    const files = (await readdir(this.directory)).filter((file) => /^fixture_[a-f0-9]{24}\.json$/.test(file)).sort();
    const fixtures: ReplayFixture[] = [];
    for (const file of files) {
      const fixture = await this.get(file.slice(0, -5));
      if (!splits || splits.has(fixture.split)) fixtures.push(fixture);
    }
    return fixtures;
  }

  public async forEpisode(episodeId: string): Promise<ReplayFixture | undefined> {
    return (await this.list()).find((fixture) => fixture.sourceEpisodeId === episodeId);
  }

  public async capture(episodeId: string, split?: FixtureSplit): Promise<ReplayFixture> {
    const existing = await this.forEpisode(episodeId);
    if (existing) return existing;

    const checkpoint = await this.checkpoints.load(episodeId);
    if (checkpoint.status !== "committed" || !checkpoint.answer) {
      throw new EvolveError("FIXTURE_EPISODE", "Only committed Episodes with a final answer can become replay fixtures");
    }
    const events = await this.ledger.forEpisode(episodeId);
    const forbidden = new Set([
      "tool.arguments_rejected",
      "tool.policy_denied",
      "approval.denied",
      "episode.failed",
      "episode.budget_exhausted",
    ]);
    const unsafe = events.find((event) => forbidden.has(event.type));
    if (unsafe) {
      throw new EvolveError("FIXTURE_EPISODE", `Episode contains a non-replayable event: ${unsafe.type}`);
    }

    const trace = await this.traceFrom(events, checkpoint.observations);
    if (trace.length !== checkpoint.toolCalls || trace.length !== checkpoint.toolSequence.length) {
      throw new EvolveError(
        "FIXTURE_TRACE",
        `Replayable tool count mismatch: trace=${trace.length}, calls=${checkpoint.toolCalls}, successful=${checkpoint.toolSequence.length}`,
      );
    }
    const committed = events.findLast((event) => event.type === "episode.committed");
    if (!committed) throw new EvolveError("FIXTURE_EPISODE", "Episode has no committed ledger event");
    const committedPayload = objectValue(committed.payload);
    const answerHash = requiredString(committedPayload, "answer_hash");
    const verifierScore = checkpoint.finalScore ?? numberValue(committedPayload, "score", 0);

    return this.put({
      version: 1,
      sourceEpisodeId: episodeId,
      split: split ?? splitFor(episodeId),
      createdAt: new Date().toISOString(),
      task: checkpoint.task,
      trace,
      baseline: {
        status: "committed",
        answerHash,
        verifierScore,
        usage: checkpoint.usage,
        turns: checkpoint.turns,
        toolCalls: checkpoint.toolCalls,
        elapsedMs: checkpoint.elapsedMs,
        activeSkillIds: checkpoint.activeSkillIds ?? [],
      },
    });
  }

  private async traceFrom(
    events: LedgerEvent[],
    observations: Array<{ content: string; evidenceId?: string; toolName?: string }>,
  ): Promise<ReplayTraceStep[]> {
    const pending: Array<{ toolName: string; argsHash: string }> = [];
    const trace: ReplayTraceStep[] = [];

    for (const event of events) {
      const payload = objectValue(event.payload);
      if (event.type === "model.tool_proposed") {
        pending.push({
          toolName: requiredString(payload, "tool"),
          argsHash: requiredString(payload, "args_hash"),
        });
        continue;
      }
      if (event.type !== "tool.executed" && event.type !== "tool.failed") continue;
      const toolName = requiredString(payload, "tool");
      const proposalIndex = pending.findIndex((proposal) => proposal.toolName === toolName);
      if (proposalIndex < 0) throw new EvolveError("FIXTURE_TRACE", `No proposal for executed tool ${toolName}`);
      const [proposal] = pending.splice(proposalIndex, 1);
      if (!proposal) throw new EvolveError("FIXTURE_TRACE", `Missing proposal for ${toolName}`);
      const evidenceId = requiredString(payload, "evidence_id");
      const evidence = await this.artifacts.getEvidence(evidenceId);
      if (!evidence || evidence.episodeId !== event.episodeId) {
        throw new EvolveError("FIXTURE_TRACE", `Missing evidence ${evidenceId}`);
      }
      const executedArgsHash = requiredString(payload, "args_hash");
      if (executedArgsHash !== evidence.argsHash) {
        throw new EvolveError("FIXTURE_TRACE", `Executed arguments do not match evidence ${evidenceId}`);
      }
      const observation = observations.find((entry) => entry.evidenceId === evidenceId)?.content;
      trace.push({
        index: trace.length,
        toolName,
        argsHash: proposal.argsHash,
        evidence,
        observation: observation ?? `${evidence.summary} [evidence:${evidence.id}]`,
        success: evidence.success,
      });
    }
    if (pending.length > 0) throw new EvolveError("FIXTURE_TRACE", "Episode contains proposed tools without evidence");
    return trace;
  }
}
