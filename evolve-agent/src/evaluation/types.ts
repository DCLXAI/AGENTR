import type { EvidenceRecord, SkillRecord, TaskSpec, Usage } from "../core/types.js";

export type FixtureSplit = "train" | "validation" | "holdout";
export type EvaluationReportKind = "offline" | "canary" | "monitor";
export type EvaluationArm = "baseline" | "candidate";

export interface ReplayTraceStep {
  index: number;
  toolName: string;
  argsHash: string;
  evidence: EvidenceRecord;
  observation: string;
  success: boolean;
}

export interface ReplayFixturePayload {
  version: 1;
  sourceEpisodeId: string;
  split: FixtureSplit;
  createdAt: string;
  task: TaskSpec;
  trace: ReplayTraceStep[];
  baseline: {
    status: "committed";
    answerHash: string;
    verifierScore: number;
    usage: Usage;
    turns: number;
    toolCalls: number;
    elapsedMs: number;
    activeSkillIds: string[];
  };
}

export interface ReplayFixture extends ReplayFixturePayload {
  id: string;
  integrityHash: string;
}

export interface ReplayRunResult {
  fixtureId: string;
  fixtureHash: string;
  sourceEpisodeId: string;
  arm: EvaluationArm;
  repeat: number;
  success: boolean;
  verifierScore: number;
  usage: Usage;
  turns: number;
  toolCalls: number;
  durationMs: number;
  traceMatched: boolean;
  failureReason?: string;
  safetyViolations: string[];
  activeSkillIds: string[];
}

export interface EvaluationAggregate {
  samples: number;
  successes: number;
  successRate: number;
  meanVerifierScore: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanTotalTokens: number;
  meanTurns: number;
  meanToolCalls: number;
  meanDurationMs: number;
  traceMatchRate: number;
  safetyViolations: number;
}

export interface EvaluationPolicy {
  minFixtures: number;
  repeats: number;
  maxNewFailures: number;
  maxSuccessRegression: number;
  maxScoreRegression: number;
  minSuccessImprovement: number;
  minScoreImprovement: number;
  maxTokenRegressionRatio: number;
  maxToolCallRegressionRatio: number;
  efficiencyImprovementRatio: number;
  confidenceLevel: number;
  bootstrapSamples: number;
  requireImprovement: boolean;
}

export interface EvaluationComparison {
  pairedSamples: number;
  wins: number;
  losses: number;
  ties: number;
  newFailures: number;
  successDelta: number;
  verifierScoreDelta: number;
  totalTokenRatio: number;
  toolCallRatio: number;
  durationRatio: number;
  confidence: {
    successDeltaLower: number;
    successDeltaUpper: number;
    verifierScoreDeltaLower: number;
    verifierScoreDeltaUpper: number;
  };
}

export interface EvaluationDecision {
  passed: boolean;
  gates: Record<string, boolean>;
  reasons: string[];
}

export interface EvaluationReportPayload {
  version: 1;
  engineVersion: "0.3.0";
  kind: EvaluationReportKind;
  skillId: string;
  skillFingerprint: string;
  createdAt: string;
  fixtureIds: string[];
  fixtureHashes: string[];
  policy: EvaluationPolicy;
  baselineRuns: ReplayRunResult[];
  candidateRuns: ReplayRunResult[];
  baseline: EvaluationAggregate;
  candidate: EvaluationAggregate;
  comparison: EvaluationComparison;
  decision: EvaluationDecision;
  metadata: {
    provider: string;
    notes: string[];
  };
}

export interface SignedEvaluationReport {
  id: string;
  payload: EvaluationReportPayload;
  payloadHash: string;
  signature: string;
  keyFingerprint: string;
}

export interface ShadowObservation {
  id: string;
  skillId: string;
  episodeId: string;
  fixtureId: string;
  mode: "production-baseline" | "production-candidate";
  baseline: ReplayRunResult;
  candidate: ReplayRunResult;
  createdAt: string;
}

export interface ProductionOutcome {
  id: string;
  skillId: string;
  episodeId: string;
  createdAt: string;
  success: boolean;
  verifierScore: number;
  usage: Usage;
  turns: number;
  toolCalls: number;
  status: string;
}

export interface PromotionAuthorization {
  offlineReportId: string;
  canaryReportId: string;
  policyHash: string;
  keyFingerprint: string;
}

export interface EvaluationSelection {
  fixtures?: string[];
  splits?: FixtureSplit[];
  repeats?: number;
}

export interface ReplayHarnessInput {
  fixture: ReplayFixture;
  arm: EvaluationArm;
  repeat: number;
  skills: SkillRecord[];
}
