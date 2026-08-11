import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProvenanceSigner } from "../src/evaluation/provenance-signer.js";
import { defaultEvaluationPolicy } from "../src/evaluation/metrics.js";
import type { EvaluationReportPayload } from "../src/evaluation/types.js";

function payload(): EvaluationReportPayload {
  const empty = {
    samples: 0,
    successes: 0,
    successRate: 0,
    meanVerifierScore: 0,
    meanInputTokens: 0,
    meanOutputTokens: 0,
    meanTotalTokens: 0,
    meanTurns: 0,
    meanToolCalls: 0,
    meanDurationMs: 0,
    traceMatchRate: 0,
    safetyViolations: 0,
  };
  return {
    version: 1,
    engineVersion: "0.3.0",
    kind: "offline",
    skillId: "skill_aaaaaaaaaaaaaaaaaaaaaaaa",
    skillFingerprint: "a".repeat(64),
    createdAt: new Date(0).toISOString(),
    fixtureIds: [],
    fixtureHashes: [],
    policy: defaultEvaluationPolicy(),
    baselineRuns: [],
    candidateRuns: [],
    baseline: empty,
    candidate: empty,
    comparison: {
      pairedSamples: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      newFailures: 0,
      successDelta: 0,
      verifierScoreDelta: 0,
      totalTokenRatio: 1,
      toolCallRatio: 1,
      durationRatio: 1,
      confidence: {
        successDeltaLower: 0,
        successDeltaUpper: 0,
        verifierScoreDeltaLower: 0,
        verifierScoreDeltaUpper: 0,
      },
    },
    decision: { passed: false, gates: {}, reasons: ["fixture"] },
    metadata: { provider: "test", notes: [] },
  };
}

test("Ed25519 evaluation provenance rejects report tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-sign-"));
  try {
    const signer = new ProvenanceSigner(root);
    const report = await signer.sign(payload());
    assert.equal(await signer.verify(report), true);
    const tampered = structuredClone(report);
    tampered.payload.decision.passed = true;
    assert.equal(await signer.verify(tampered), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
