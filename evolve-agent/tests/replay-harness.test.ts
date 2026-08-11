import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/ledger/artifact-store.js";
import { JsonlLedger } from "../src/ledger/jsonl-ledger.js";
import { CheckpointStore } from "../src/runtime/checkpoint-store.js";
import { FixtureStore } from "../src/evaluation/fixture-store.js";
import { ReplayHarness } from "../src/evaluation/replay-harness.js";
import { SkillStore } from "../src/skills/skill-store.js";
import type { AgentProvider } from "../src/providers/provider.js";
import { SkillAwareProvider, candidateInput, fixturePayload } from "./evaluation-helpers.js";

const tool = {
  name: "read_file",
  description: "Read a file",
  risk: "read" as const,
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

test("replay harness gives baseline and candidate the same recorded world", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-replay-"));
  try {
    const fixtureStore = new FixtureStore(
      root,
      new CheckpointStore(root),
      new JsonlLedger(path.join(root, "episodes.jsonl")),
      new ArtifactStore(root),
    );
    const skillStore = new SkillStore(root);
    const skill = await skillStore.upsertCandidate(candidateInput());
    const fixture = await fixtureStore.put(fixturePayload(5));
    const provider = new SkillAwareProvider(skill.id);
    const harness = new ReplayHarness(provider, [tool]);
    const baseline = await harness.run({ fixture, arm: "baseline", repeat: 0, skills: [] });
    const candidate = await harness.run({ fixture, arm: "candidate", repeat: 0, skills: [skill] });
    assert.equal(baseline.success, true);
    assert.equal(candidate.success, true);
    assert.equal(candidate.verifierScore, 0.96);
    assert.ok(candidate.usage.totalTokens < baseline.usage.totalTokens);
    assert.equal(candidate.fixtureHash, baseline.fixtureHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replay harness fails closed when proposed arguments diverge from the fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-replay-mismatch-"));
  try {
    const fixtureStore = new FixtureStore(
      root,
      new CheckpointStore(root),
      new JsonlLedger(path.join(root, "episodes.jsonl")),
      new ArtifactStore(root),
    );
    const fixture = await fixtureStore.put(fixturePayload(6));
    const provider: AgentProvider = {
      async decide() {
        return {
          decision: { kind: "tool", toolName: "read_file", args: { path: "wrong.txt" }, rationale: "wrong" },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async verify() {
        throw new Error("Verifier must not run after trace mismatch");
      },
    };
    const result = await new ReplayHarness(provider, [tool]).run({ fixture, arm: "baseline", repeat: 0, skills: [] });
    assert.equal(result.success, false);
    assert.ok(result.safetyViolations.includes("trace_mismatch"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
