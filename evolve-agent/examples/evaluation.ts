import { createRuntime, loadConfig } from "@dclxai/evolve-agent";

const { fixtures, evaluations } = createRuntime(
  loadConfig({
    workspace: process.cwd(),
    evaluation: {
      captureCommitted: false,
      shadowPercent: 0,
      policy: { minFixtures: 5, repeats: 2 },
    },
  }),
);

// Capture reviewed clean Episodes before evaluating a Skill.
await fixtures.capture("ep_000000000000000000000001", "validation");
await fixtures.capture("ep_000000000000000000000002", "holdout");

const report = await evaluations.evaluateSkill("skill_000000000000000000000001", {
  splits: ["validation", "holdout"],
  repeats: 2,
});

console.log({
  reportId: report.id,
  passed: report.payload.decision.passed,
  scoreDelta: report.payload.comparison.verifierScoreDelta,
  tokenRatio: report.payload.comparison.totalTokenRatio,
});
