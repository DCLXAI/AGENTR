import assert from "node:assert/strict";
import test from "node:test";
import { compareRuns, defaultEvaluationPolicy } from "../src/evaluation/metrics.js";
import type { ReplayRunResult } from "../src/evaluation/types.js";

function run(fixture: number, arm: "baseline" | "candidate", input: Partial<ReplayRunResult> = {}): ReplayRunResult {
  return {
    fixtureId: `fixture_${fixture.toString(16).padStart(24, "0")}`,
    fixtureHash: fixture.toString(16).padStart(64, "0"),
    sourceEpisodeId: `ep_${fixture.toString(16).padStart(24, "0")}`,
    arm,
    repeat: 0,
    success: true,
    verifierScore: arm === "candidate" ? 0.95 : 0.82,
    usage: arm === "candidate"
      ? { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
      : { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
    turns: 2,
    toolCalls: 1,
    durationMs: 10,
    traceMatched: true,
    safetyViolations: [],
    activeSkillIds: [],
    ...input,
  };
}

test("evaluation gate accepts paired quality and efficiency improvement", () => {
  const baseline = [run(1, "baseline"), run(2, "baseline"), run(3, "baseline")];
  const candidate = [run(1, "candidate"), run(2, "candidate"), run(3, "candidate")];
  const result = compareRuns(baseline, candidate, defaultEvaluationPolicy({ minFixtures: 3, bootstrapSamples: 200 }));
  assert.equal(result.decision.passed, true);
  assert.ok(result.comparison.verifierScoreDelta > 0.1);
  assert.ok(result.comparison.totalTokenRatio < 1);
});

test("evaluation gate rejects one new failure even when average cost improves", () => {
  const baseline = [run(1, "baseline"), run(2, "baseline"), run(3, "baseline")];
  const candidate = [run(1, "candidate"), run(2, "candidate", { success: false, verifierScore: 0 }), run(3, "candidate")];
  const result = compareRuns(baseline, candidate, defaultEvaluationPolicy({ minFixtures: 3, bootstrapSamples: 200 }));
  assert.equal(result.decision.passed, false);
  assert.equal(result.decision.gates.no_new_failures, false);
});
