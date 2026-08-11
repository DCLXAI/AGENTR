import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/factory.js";
import { SkillAwareProvider, candidateInput, fixturePayload } from "./evaluation-helpers.js";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-eval-engine-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const provider = new SkillAwareProvider("");
  const config = loadConfig({
    home,
    workspace,
    evaluation: {
      canaryMinSamples: 3,
      monitorMinSamples: 2,
      monitorWindow: 10,
      policy: {
        minFixtures: 3,
        repeats: 1,
        bootstrapSamples: 200,
      },
    },
  });
  const bundle = createRuntime(config, { provider });
  const skill = await bundle.skills.upsertCandidate(candidateInput());
  provider.candidateSkillId = skill.id;
  return { root, workspace, home, provider, bundle, skill };
}

test("offline evaluation excludes training Episodes and creates a signed report", async () => {
  const environment = await setup();
  try {
    for (let index = 1; index <= 4; index += 1) await environment.bundle.fixtures.put(fixturePayload(index));
    // A fixture sourced from the candidate's training provenance must never enter the report.
    const leaked = fixturePayload(50);
    leaked.sourceEpisodeId = environment.skill.supportingEpisodes[0] as string;
    leaked.trace[0]!.evidence.episodeId = leaked.sourceEpisodeId;
    const leakedFixture = await environment.bundle.fixtures.put(leaked);

    const report = await environment.bundle.evaluations.evaluateSkill(environment.skill.id, {
      fixtures: [...(await environment.bundle.fixtures.list()).map((fixture) => fixture.id)],
    });
    assert.equal(report.payload.decision.passed, true);
    assert.equal(await environment.bundle.evaluations.verifyReport(report.id), true);
    assert.equal(report.payload.fixtureIds.includes(leakedFixture.id), false);
    assert.ok(report.payload.comparison.verifierScoreDelta > 0.1);
    assert.ok(report.payload.comparison.totalTokenRatio < 1);
    const skill = await environment.bundle.skills.get(environment.skill.id);
    assert.equal(skill.status, "evaluated");
    assert.deepEqual(skill.evaluationReportIds, [report.id]);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("shadow canary stays off the production path and explicit promotion requires both signed reports", async () => {
  const environment = await setup();
  try {
    for (let index = 1; index <= 6; index += 1) await environment.bundle.fixtures.put(fixturePayload(index));
    const offline = await environment.bundle.evaluations.evaluateSkill(environment.skill.id, {
      fixtures: (await environment.bundle.fixtures.list()).slice(0, 3).map((fixture) => fixture.id),
    });
    assert.equal(offline.payload.decision.passed, true);

    const holdouts = (await environment.bundle.fixtures.list()).slice(3, 6);
    for (const fixture of holdouts) {
      const observation = await environment.bundle.evaluations.shadowEpisode(
        environment.skill.id,
        fixture.sourceEpisodeId,
        "production-baseline",
      );
      assert.equal(observation.mode, "production-baseline");
      assert.equal(observation.baseline.activeSkillIds.includes(environment.skill.id), false);
      assert.equal(observation.candidate.activeSkillIds.includes(environment.skill.id), true);
    }
    const skillAfterCanary = await environment.bundle.skills.get(environment.skill.id);
    assert.equal(skillAfterCanary.status, "canary");
    assert.equal(skillAfterCanary.canaryReportIds.length, 1);
    const promoted = await environment.bundle.evaluations.promoteSkill(environment.skill.id);
    assert.equal(promoted.status, "promoted");
    assert.ok(promoted.promotion?.offlineReportId);
    assert.ok(promoted.promotion?.canaryReportId);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("production regression monitor automatically rolls back a promoted Skill", async () => {
  const environment = await setup();
  try {
    for (let index = 1; index <= 6; index += 1) await environment.bundle.fixtures.put(fixturePayload(index));
    await environment.bundle.evaluations.evaluateSkill(environment.skill.id, {
      fixtures: (await environment.bundle.fixtures.list()).slice(0, 3).map((fixture) => fixture.id),
    });
    for (const fixture of (await environment.bundle.fixtures.list()).slice(3, 6)) {
      await environment.bundle.evaluations.shadowEpisode(environment.skill.id, fixture.sourceEpisodeId, "production-baseline");
    }
    await environment.bundle.evaluations.promoteSkill(environment.skill.id);

    for (let index = 0; index < 2; index += 1) {
      await environment.bundle.evaluations.recordProduction({
        version: 1,
        episodeId: `ep_${(900 + index).toString(16).padStart(24, "0")}`,
        task: fixturePayload(index + 20).task,
        status: "failed",
        observations: [],
        evidenceIds: [],
        toolSequence: [],
        activeSkillIds: [environment.skill.id],
        usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
        turns: 3,
        toolCalls: 1,
        elapsedMs: 100,
        finalScore: 0,
        stopReason: "regression",
        updatedAt: new Date().toISOString(),
      });
    }
    const rolledBack = await environment.bundle.skills.get(environment.skill.id);
    assert.equal(rolledBack.status, "rolled_back");
    assert.equal(rolledBack.rollback?.automatic, true);
    assert.ok(rolledBack.rollback?.reportId);
    assert.equal(await environment.bundle.evaluations.verifyReport(rolledBack.rollback?.reportId as string), true);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});


test("promotion refuses a tampered signed evaluation report", async () => {
  const environment = await setup();
  try {
    for (let index = 1; index <= 6; index += 1) await environment.bundle.fixtures.put(fixturePayload(index));
    await environment.bundle.evaluations.evaluateSkill(environment.skill.id, {
      fixtures: (await environment.bundle.fixtures.list()).slice(0, 3).map((fixture) => fixture.id),
    });
    for (const fixture of (await environment.bundle.fixtures.list()).slice(3, 6)) {
      await environment.bundle.evaluations.shadowEpisode(environment.skill.id, fixture.sourceEpisodeId, "production-baseline");
    }
    const skill = await environment.bundle.skills.get(environment.skill.id);
    const canaryId = skill.canaryReportIds.at(-1) as string;
    const reportPath = path.join(environment.home, "evaluations", "reports", `${canaryId}.json`);
    const { readFile, writeFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { payload: { decision: { passed: boolean } } };
    report.payload.decision.passed = false;
    await writeFile(reportPath, JSON.stringify(report), "utf8");
    await assert.rejects(environment.bundle.evaluations.promoteSkill(environment.skill.id), /signature/i);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
