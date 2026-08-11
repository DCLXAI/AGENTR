export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface TaskBudget {
  maxTurns: number;
  maxToolCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallTimeMs: number;
}

export interface TaskSpec {
  id: string;
  goal: string;
  constraints: string[];
  successCriteria: string[];
  requestedTools: string[];
  budget: TaskBudget;
  createdAt: string;
}

export interface TaskInput {
  goal: string;
  constraints?: string[];
  successCriteria?: string[];
  requestedTools?: string[];
  budget?: Partial<TaskBudget>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type EpisodeStatus = "running" | "committed" | "budget_exhausted" | "interrupted" | "failed";

export interface EvidenceRecord {
  id: string;
  episodeId: string;
  toolName: string;
  argsHash: string;
  artifactHash: string;
  summary: string;
  success: boolean;
  createdAt: string;
}

export interface LedgerEvent {
  version: 1;
  index: number;
  timestamp: string;
  episodeId: string;
  type: string;
  payload: JsonValue;
  prevHash: string | null;
  hash: string;
}

export interface LedgerVerification {
  valid: boolean;
  events: number;
  error?: string;
}

export interface MemoryRecord {
  id: string;
  text: string;
  tags: string[];
  confidence: number;
  sourceEpisodeId: string;
  evidenceIds: string[];
  createdAt: string;
}

export type SkillStatus = "candidate" | "evaluated" | "canary" | "promoted" | "quarantined" | "rolled_back";

export interface SkillStep {
  toolName: string;
  purpose: string;
}

export interface SkillEvaluation {
  at: string;
  policyPassed: boolean;
  replayPassed: boolean;
  score: number;
  notes: string[];
}

export interface SkillCanary {
  at: string;
  passed: boolean;
  score: number;
  note: string;
}

export interface SkillPromotionRecord {
  at: string;
  offlineReportId: string;
  canaryReportId: string;
  policyHash: string;
  keyFingerprint: string;
}

export interface SkillRollbackRecord {
  at: string;
  reason: string;
  automatic: boolean;
  reportId?: string;
}

export interface SkillRecord {
  id: string;
  fingerprint: string;
  name: string;
  description: string;
  triggers: string[];
  steps: SkillStep[];
  allowedTools: string[];
  supportingEpisodes: string[];
  provenanceEvidenceIds: string[];
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;
  evaluations: SkillEvaluation[];
  canaries: SkillCanary[];
  evaluationReportIds: string[];
  canaryReportIds: string[];
  promotion?: SkillPromotionRecord;
  rollback?: SkillRollbackRecord;
}

export interface EpisodeCheckpoint {
  version: 1;
  episodeId: string;
  task: TaskSpec;
  status: EpisodeStatus;
  observations: Array<{
    id: string;
    kind: "tool" | "error" | "verification" | "system";
    content: string;
    evidenceId?: string;
    toolName?: string;
  }>;
  evidenceIds: string[];
  toolSequence: string[];
  activeSkillIds: string[];
  usage: Usage;
  turns: number;
  toolCalls: number;
  elapsedMs: number;
  answer?: string;
  finalScore?: number;
  stopReason?: string;
  updatedAt: string;
}

export interface RunResult {
  episodeId: string;
  status: EpisodeStatus;
  answer?: string;
  evidenceIds: string[];
  usage: Usage;
  turns: number;
  toolCalls: number;
  reason?: string;
}
