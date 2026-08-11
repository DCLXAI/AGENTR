import type { EvidenceRecord, JsonObject, MemoryRecord, SkillRecord, TaskSpec, Usage } from "../core/types.js";
import type { ToolDescription } from "../tools/types.js";

export interface Observation {
  id: string;
  kind: "tool" | "error" | "verification" | "system";
  content: string;
  evidenceId?: string;
  toolName?: string;
}

export interface AgentPrompt {
  task: TaskSpec;
  observations: Observation[];
  memories: MemoryRecord[];
  skills: SkillRecord[];
  tools: ToolDescription[];
  remainingBudget: {
    turns: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    wallTimeMs: number;
  };
}

export interface ToolDecision {
  kind: "tool";
  toolName: string;
  args: JsonObject;
  rationale: string;
}

export interface MemoryProposal {
  text: string;
  tags: string[];
  confidence: number;
  evidenceIds: string[];
}

export interface FinalDecision {
  kind: "final";
  answer: string;
  evidenceIds: string[];
  memoryProposals: MemoryProposal[];
}

export type AgentDecision = ToolDecision | FinalDecision;

export interface DecisionResult {
  decision: AgentDecision;
  usage: Usage;
  providerResponseId?: string;
}

export interface VerificationInput {
  task: TaskSpec;
  answer: string;
  evidence: EvidenceRecord[];
}

export interface VerificationVerdict {
  passed: boolean;
  score: number;
  feedback: string;
}

export interface VerificationResult {
  verdict: VerificationVerdict;
  usage: Usage;
  providerResponseId?: string;
}

export interface AgentProvider {
  decide(prompt: AgentPrompt): Promise<DecisionResult>;
  verify(input: VerificationInput): Promise<VerificationResult>;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
