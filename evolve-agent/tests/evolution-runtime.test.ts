import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/factory.js";
import { StaticApprover } from "../src/policy/approver.js";
import { SkillAwareProvider, candidateInput, fixturePayload } from "./evaluation-helpers.js";

test("runtime records active Skills and captures committed Episodes as replay fixtures when explicitly enabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-runtime-eval-"));
  try {
    const workspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    await writeFile(path.join(root, "placeholder"), "x", "utf8");
    const provider = new SkillAwareProvider("");
    const config = loadConfig({
      home,
      workspace,
      evaluation: {
        captureCommitted: true,
        monitorPromoted: false,
        canaryMinSamples: 3,
        monitorWindow: 10,
        policy: { minFixtures: 3, bootstrapSamples: 200 },
      },
    });
    const bundle = createRuntime(config, { provider, approver: new StaticApprover(true) });
    const skill = await bundle.skills.upsertCandidate(candidateInput(9));
    provider.candidateSkillId = skill.id;
    for (let index = 1; index <= 6; index += 1) await bundle.fixtures.put(fixturePayload(index));
    await bundle.evaluations.evaluateSkill(skill.id, {
      fixtures: (await bundle.fixtures.list()).slice(0, 3).map((fixture) => fixture.id),
    });
    for (const fixture of (await bundle.fixtures.list()).slice(3, 6)) {
      await bundle.evaluations.shadowEpisode(skill.id, fixture.sourceEpisodeId, "production-baseline");
    }
    await bundle.evaluations.promoteSkill(skill.id);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "file-0.txt"), "alpha", "utf8");

    const result = await bundle.runtime.run({
      goal: "Inspect file-0.txt and report it.",
      requestedTools: ["read_file"],
    });
    assert.equal(result.status, "committed");
    const checkpoint = await bundle.checkpoints.load(result.episodeId);
    assert.ok(checkpoint.activeSkillIds.includes(skill.id));
    const fixtures = await bundle.fixtures.list();
    const captured = fixtures.find((fixture) => fixture.sourceEpisodeId === result.episodeId);
    assert.ok(captured);
    const events = await bundle.ledger.forEpisode(result.episodeId);
    assert.ok(events.some((event) => event.type === "evaluation.fixture_captured"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
