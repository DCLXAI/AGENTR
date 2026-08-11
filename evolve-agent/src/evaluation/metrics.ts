import { sha256Json } from "../core/hash.js";
import type {
  EvaluationAggregate,
  EvaluationComparison,
  EvaluationDecision,
  EvaluationPolicy,
  ReplayRunResult,
} from "./types.js";

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(candidate: number, baseline: number): number {
  if (baseline === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / baseline;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const index = clamp((sorted.length - 1) * probability, 0, sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const left = sorted[lower] ?? 0;
  const right = sorted[upper] ?? left;
  return left + (right - left) * (index - lower);
}

function seedFrom(value: unknown): number {
  const seed = Number.parseInt(sha256Json(value).slice(0, 8), 16) >>> 0;
  return seed === 0 ? 0x9e3779b9 : seed;
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function aggregateRuns(runs: ReplayRunResult[]): EvaluationAggregate {
  const samples = runs.length;
  const successes = runs.filter((run) => run.success).length;
  return {
    samples,
    successes,
    successRate: samples === 0 ? 0 : successes / samples,
    meanVerifierScore: mean(runs.map((run) => run.verifierScore)),
    meanInputTokens: mean(runs.map((run) => run.usage.inputTokens)),
    meanOutputTokens: mean(runs.map((run) => run.usage.outputTokens)),
    meanTotalTokens: mean(runs.map((run) => run.usage.totalTokens)),
    meanTurns: mean(runs.map((run) => run.turns)),
    meanToolCalls: mean(runs.map((run) => run.toolCalls)),
    meanDurationMs: mean(runs.map((run) => run.durationMs)),
    traceMatchRate: samples === 0 ? 0 : runs.filter((run) => run.traceMatched).length / samples,
    safetyViolations: runs.reduce((sum, run) => sum + run.safetyViolations.length, 0),
  };
}

function pairRuns(
  baselineRuns: ReplayRunResult[],
  candidateRuns: ReplayRunResult[],
): Array<{ baseline: ReplayRunResult; candidate: ReplayRunResult }> {
  const baseline = new Map(baselineRuns.map((run) => [`${run.fixtureId}:${run.repeat}`, run]));
  const pairs: Array<{ baseline: ReplayRunResult; candidate: ReplayRunResult }> = [];
  for (const candidate of candidateRuns) {
    const match = baseline.get(`${candidate.fixtureId}:${candidate.repeat}`);
    if (match) pairs.push({ baseline: match, candidate });
  }
  return pairs;
}

function bootstrapIntervals(
  pairs: Array<{ baseline: ReplayRunResult; candidate: ReplayRunResult }>,
  policy: EvaluationPolicy,
): EvaluationComparison["confidence"] {
  if (pairs.length === 0) {
    return {
      successDeltaLower: 0,
      successDeltaUpper: 0,
      verifierScoreDeltaLower: 0,
      verifierScoreDeltaUpper: 0,
    };
  }
  const random = randomGenerator(seedFrom({ pairs, policy }));
  const successDeltas: number[] = [];
  const scoreDeltas: number[] = [];
  for (let iteration = 0; iteration < policy.bootstrapSamples; iteration += 1) {
    const selected = Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)] as (typeof pairs)[number]);
    successDeltas.push(
      mean(selected.map(({ baseline, candidate }) => Number(candidate.success) - Number(baseline.success))),
    );
    scoreDeltas.push(mean(selected.map(({ baseline, candidate }) => candidate.verifierScore - baseline.verifierScore)));
  }
  successDeltas.sort((left, right) => left - right);
  scoreDeltas.sort((left, right) => left - right);
  const tail = (1 - policy.confidenceLevel) / 2;
  return {
    successDeltaLower: quantile(successDeltas, tail),
    successDeltaUpper: quantile(successDeltas, 1 - tail),
    verifierScoreDeltaLower: quantile(scoreDeltas, tail),
    verifierScoreDeltaUpper: quantile(scoreDeltas, 1 - tail),
  };
}

export function compareRuns(
  baselineRuns: ReplayRunResult[],
  candidateRuns: ReplayRunResult[],
  policy: EvaluationPolicy,
): {
  baseline: EvaluationAggregate;
  candidate: EvaluationAggregate;
  comparison: EvaluationComparison;
  decision: EvaluationDecision;
} {
  const baseline = aggregateRuns(baselineRuns);
  const candidate = aggregateRuns(candidateRuns);
  const pairs = pairRuns(baselineRuns, candidateRuns);
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let newFailures = 0;
  for (const pair of pairs) {
    const baselineUtility = Number(pair.baseline.success) * 10 + pair.baseline.verifierScore;
    const candidateUtility = Number(pair.candidate.success) * 10 + pair.candidate.verifierScore;
    if (candidateUtility > baselineUtility + 1e-9) wins += 1;
    else if (candidateUtility < baselineUtility - 1e-9) losses += 1;
    else ties += 1;
    if (pair.baseline.success && !pair.candidate.success) newFailures += 1;
  }

  const comparison: EvaluationComparison = {
    pairedSamples: pairs.length,
    wins,
    losses,
    ties,
    newFailures,
    successDelta: candidate.successRate - baseline.successRate,
    verifierScoreDelta: candidate.meanVerifierScore - baseline.meanVerifierScore,
    totalTokenRatio: ratio(candidate.meanTotalTokens, baseline.meanTotalTokens),
    toolCallRatio: ratio(candidate.meanToolCalls, baseline.meanToolCalls),
    durationRatio: ratio(candidate.meanDurationMs, baseline.meanDurationMs),
    confidence: bootstrapIntervals(pairs, policy),
  };

  const fixtureCount = new Set(candidateRuns.map((run) => run.fixtureId)).size;
  const qualityNonRegression = comparison.successDelta >= -policy.maxSuccessRegression;
  const scoreNonRegression = comparison.verifierScoreDelta >= -policy.maxScoreRegression;
  const confidenceNonRegression =
    comparison.confidence.successDeltaLower >= -policy.maxSuccessRegression &&
    comparison.confidence.verifierScoreDeltaLower >= -policy.maxScoreRegression;
  const qualityImprovement =
    comparison.successDelta >= policy.minSuccessImprovement ||
    comparison.verifierScoreDelta >= policy.minScoreImprovement ||
    comparison.totalTokenRatio <= policy.efficiencyImprovementRatio ||
    comparison.toolCallRatio <= policy.efficiencyImprovementRatio;

  const gates: Record<string, boolean> = {
    minimum_fixtures: fixtureCount >= policy.minFixtures,
    paired_completeness: pairs.length === baselineRuns.length && pairs.length === candidateRuns.length,
    no_new_failures: comparison.newFailures <= policy.maxNewFailures,
    quality_non_regression: qualityNonRegression,
    score_non_regression: scoreNonRegression,
    confidence_non_regression: confidenceNonRegression,
    token_budget: comparison.totalTokenRatio <= policy.maxTokenRegressionRatio,
    tool_budget: comparison.toolCallRatio <= policy.maxToolCallRegressionRatio,
    trace_integrity: candidate.traceMatchRate >= baseline.traceMatchRate && candidate.safetyViolations <= baseline.safetyViolations,
    improvement: !policy.requireImprovement || qualityImprovement,
  };
  const reasons = Object.entries(gates)
    .filter(([, passed]) => !passed)
    .map(([gate]) => `Gate failed: ${gate}`);
  if (reasons.length === 0) reasons.push("All evaluation gates passed");
  return {
    baseline,
    candidate,
    comparison,
    decision: { passed: Object.values(gates).every(Boolean), gates, reasons },
  };
}

export function defaultEvaluationPolicy(input: Partial<EvaluationPolicy> = {}): EvaluationPolicy {
  return {
    minFixtures: input.minFixtures ?? 3,
    repeats: input.repeats ?? 1,
    maxNewFailures: input.maxNewFailures ?? 0,
    maxSuccessRegression: input.maxSuccessRegression ?? 0,
    maxScoreRegression: input.maxScoreRegression ?? 0.02,
    minSuccessImprovement: input.minSuccessImprovement ?? 0.05,
    minScoreImprovement: input.minScoreImprovement ?? 0.02,
    maxTokenRegressionRatio: input.maxTokenRegressionRatio ?? 1.2,
    maxToolCallRegressionRatio: input.maxToolCallRegressionRatio ?? 1.2,
    efficiencyImprovementRatio: input.efficiencyImprovementRatio ?? 0.9,
    confidenceLevel: input.confidenceLevel ?? 0.9,
    bootstrapSamples: input.bootstrapSamples ?? 1_000,
    requireImprovement: input.requireImprovement ?? true,
  };
}
