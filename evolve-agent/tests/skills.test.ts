import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillStore } from "../src/skills/skill-store.js";

async function candidate(store: SkillStore) {
  return store.upsertCandidate({
    fingerprint: "a".repeat(64),
    name: "Inspect package metadata",
    description: "Read a package manifest and report its scripts.",
    triggers: ["package", "scripts"],
    steps: [{ toolName: "read_file", purpose: "Read the manifest" }],
    allowedTools: ["read_file"],
    supportingEpisodes: [
      "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
      "ep_bbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    provenanceEvidenceIds: ["ev_aaaaaaaaaaaaaaaaaaaaaaaa", "ev_bbbbbbbbbbbbbbbbbbbbbbbb"],
  });
}

test("skill promotion requires attached offline and canary reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-skills-"));
  try {
    const unauthorizedStore = new SkillStore(path.join(root, "unauthorized"));
    const unauthorized = await candidate(unauthorizedStore);
    await unauthorizedStore.attachEvaluationReport(unauthorized.id, "report_aaaaaaaaaaaaaaaaaaaaaaaa", true);
    await unauthorizedStore.attachCanaryReport(unauthorized.id, "report_bbbbbbbbbbbbbbbbbbbbbbbb", true);
    await assert.rejects(
      unauthorizedStore.promote(unauthorized.id, {
        offlineReportId: "report_aaaaaaaaaaaaaaaaaaaaaaaa",
        canaryReportId: "report_bbbbbbbbbbbbbbbbbbbbbbbb",
        policyHash: "c".repeat(64),
        keyFingerprint: "d".repeat(32),
      }),
      /signed-report promotion verifier/i,
    );

    const store = new SkillStore(root, { async verifyPromotion() {} });
    const skill = await candidate(store);
    await assert.rejects(
      store.promote(skill.id, {
        offlineReportId: "report_aaaaaaaaaaaaaaaaaaaaaaaa",
        canaryReportId: "report_bbbbbbbbbbbbbbbbbbbbbbbb",
        policyHash: "c".repeat(64),
        keyFingerprint: "d".repeat(32),
      }),
      /canary state/i,
    );
    await store.attachEvaluationReport(skill.id, "report_aaaaaaaaaaaaaaaaaaaaaaaa", true);
    await store.attachCanaryReport(skill.id, "report_bbbbbbbbbbbbbbbbbbbbbbbb", true);
    const promoted = await store.promote(skill.id, {
      offlineReportId: "report_aaaaaaaaaaaaaaaaaaaaaaaa",
      canaryReportId: "report_bbbbbbbbbbbbbbbbbbbbbbbb",
      policyHash: "c".repeat(64),
      keyFingerprint: "d".repeat(32),
    });
    assert.equal(promoted.status, "promoted");
    assert.equal(promoted.promotion?.offlineReportId, "report_aaaaaaaaaaaaaaaaaaaaaaaa");
    const rolledBack = await store.rollback(skill.id, "Regression observed", {
      automatic: true,
      reportId: "report_cccccccccccccccccccccccc",
    });
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(rolledBack.rollback?.automatic, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evaluation freezes supporting Episodes so later runs remain holdout material", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-skills-freeze-"));
  try {
    const store = new SkillStore(root);
    const skill = await candidate(store);
    await store.attachEvaluationReport(skill.id, "report_aaaaaaaaaaaaaaaaaaaaaaaa", true);
    const updated = await store.upsertCandidate({
      fingerprint: skill.fingerprint,
      name: skill.name,
      description: skill.description,
      triggers: ["metadata"],
      steps: skill.steps,
      allowedTools: skill.allowedTools,
      supportingEpisodes: ["ep_cccccccccccccccccccccccc"],
      provenanceEvidenceIds: ["ev_cccccccccccccccccccccccc"],
    });
    assert.deepEqual(updated.supportingEpisodes, skill.supportingEpisodes);
    assert.ok(updated.triggers.includes("metadata"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
