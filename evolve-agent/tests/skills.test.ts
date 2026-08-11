import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore } from "../src/skills/skill-store.js";

test("skill promotion requires evaluation and a passing canary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-skills-"));
  try {
    const store = new SkillStore(root);
    const skill = await store.upsertCandidate({
      fingerprint: "a".repeat(64),
      name: "Inspect package metadata",
      description: "Read a package manifest and report its scripts.",
      triggers: ["package", "scripts"],
      steps: [{ toolName: "read_file", purpose: "Read the manifest" }],
      allowedTools: ["read_file"],
      supportingEpisodes: [
        "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
        "ep_bbbbbbbbbbbbbbbbbbbbbbbb",
        "ep_cccccccccccccccccccccccc",
      ],
      provenanceEvidenceIds: ["ev_aaaaaaaaaaaaaaaaaaaaaaaa", "ev_bbbbbbbbbbbbbbbbbbbbbbbb"],
    });
    await assert.rejects(store.promote(skill.id), /evaluation/i);
    const evaluated = await store.evaluate(skill.id, new Set(["read_file"]));
    assert.equal(evaluated.evaluations.at(-1)?.score, 1);
    await assert.rejects(store.promote(skill.id), /canary/i);
    await store.recordCanary(skill.id, true, 0.91, "Isolated replay passed");
    const promoted = await store.promote(skill.id);
    assert.equal(promoted.status, "promoted");
    const rolledBack = await store.rollback(skill.id, "Regression observed");
    assert.equal(rolledBack.status, "rolled_back");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
