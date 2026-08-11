import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/ledger/artifact-store.js";
import { JsonlLedger } from "../src/ledger/jsonl-ledger.js";
import { CheckpointStore } from "../src/runtime/checkpoint-store.js";
import { FixtureStore } from "../src/evaluation/fixture-store.js";
import { sha256Json } from "../src/core/hash.js";

async function setupEpisode() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-fixture-"));
  const home = path.join(root, "home");
  const checkpoints = new CheckpointStore(home);
  const ledger = new JsonlLedger(path.join(home, "episodes.jsonl"));
  const artifacts = new ArtifactStore(home);
  const fixtures = new FixtureStore(home, checkpoints, ledger, artifacts);
  const episodeId = "ep_111111111111111111111111";
  const args = { path: "note.txt" };
  const evidence = await artifacts.put({
    episodeId,
    toolName: "read_file",
    args,
    data: { content: "alpha" },
    summary: "note.txt contains alpha",
    success: true,
  });
  await ledger.append(episodeId, "model.tool_proposed", { tool: "read_file", args_hash: sha256Json(args) });
  await ledger.append(episodeId, "tool.executed", {
    tool: "read_file",
    success: true,
    evidence_id: evidence.id,
    artifact_hash: evidence.artifactHash,
    args_hash: evidence.argsHash,
  });
  await ledger.append(episodeId, "episode.committed", {
    answer_hash: sha256Json("alpha"),
    evidence_ids: [evidence.id],
    score: 0.93,
  });
  await checkpoints.save({
    version: 1,
    episodeId,
    task: {
      id: "task_111111111111111111111111",
      goal: "Inspect note.txt",
      constraints: [],
      successCriteria: ["Cite evidence"],
      requestedTools: ["read_file"],
      budget: { maxTurns: 4, maxToolCalls: 2, maxInputTokens: 1000, maxOutputTokens: 1000, maxWallTimeMs: 1000 },
      createdAt: new Date().toISOString(),
    },
    status: "committed",
    observations: [
      {
        id: "obs_1111111111111111",
        kind: "tool",
        content: `note.txt contains alpha [evidence:${evidence.id}]`,
        evidenceId: evidence.id,
        toolName: "read_file",
      },
    ],
    evidenceIds: [evidence.id],
    toolSequence: ["read_file"],
    activeSkillIds: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    turns: 2,
    toolCalls: 1,
    elapsedMs: 50,
    answer: `alpha [evidence:${evidence.id}]`,
    finalScore: 0.93,
    updatedAt: new Date().toISOString(),
  });
  return { root, home, episodeId, fixtures };
}

test("fixture capture reconstructs a clean trace and detects tampering", async () => {
  const environment = await setupEpisode();
  try {
    const fixture = await environment.fixtures.capture(environment.episodeId, "holdout");
    assert.equal(fixture.trace.length, 1);
    assert.equal(fixture.trace[0]?.toolName, "read_file");
    assert.equal(fixture.baseline.verifierScore, 0.93);
    assert.equal(environment.fixtures.verify(fixture), true);

    const file = path.join(environment.home, "evaluations", "fixtures", `${fixture.id}.json`);
    const tampered = JSON.parse(await readFile(file, "utf8")) as typeof fixture;
    tampered.baseline.verifierScore = 0.1;
    await writeFile(file, JSON.stringify(tampered), "utf8");
    await assert.rejects(environment.fixtures.get(fixture.id), /integrity/i);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
