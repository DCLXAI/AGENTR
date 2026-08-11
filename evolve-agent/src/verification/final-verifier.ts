import { EvolveError } from "../core/errors.js";
import type { ArtifactStore } from "../ledger/artifact-store.js";
import type { AgentProvider, FinalDecision, VerificationVerdict } from "../providers/provider.js";
import type { TaskSpec, Usage } from "../core/types.js";

const EVIDENCE_PATTERN = /ev_[a-f0-9]{24}/g;

export interface FinalVerificationResult {
  passed: boolean;
  verdict: VerificationVerdict;
  usage: Usage;
  validEvidenceIds: string[];
}

export class FinalVerifier {
  public constructor(
    private readonly artifacts: ArtifactStore,
    private readonly provider: AgentProvider,
  ) {}

  public async verify(episodeId: string, task: TaskSpec, decision: FinalDecision): Promise<FinalVerificationResult> {
    const declared = [...new Set(decision.evidenceIds)];
    const declarationCheck = await this.artifacts.validateEvidenceIds(episodeId, declared);
    if (!declarationCheck.valid) {
      return {
        passed: false,
        verdict: {
          passed: false,
          score: 0,
          feedback: `The answer declared invalid or cross-episode evidence IDs: ${declarationCheck.invalid.join(", ")}`,
        },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        validEvidenceIds: declared.filter((id) => !declarationCheck.invalid.includes(id)),
      };
    }

    const cited = [...new Set(decision.answer.match(EVIDENCE_PATTERN) ?? [])];
    const undeclared = cited.filter((id) => !declared.includes(id));
    if (undeclared.length > 0) {
      return {
        passed: false,
        verdict: {
          passed: false,
          score: 0,
          feedback: `The answer cited evidence that was not declared: ${undeclared.join(", ")}`,
        },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        validEvidenceIds: declared,
      };
    }

    if (declared.length > 0 && cited.length === 0) {
      return {
        passed: false,
        verdict: {
          passed: false,
          score: 0.25,
          feedback: "Evidence was declared but the answer contains no [evidence:ev_...] citations.",
        },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        validEvidenceIds: declared,
      };
    }

    const evidence = [];
    for (const id of declared) {
      const record = await this.artifacts.getEvidence(id);
      if (!record) throw new EvolveError("EVIDENCE_MISSING", `Validated evidence disappeared: ${id}`);
      evidence.push(record);
    }
    const independent = await this.provider.verify({ task, answer: decision.answer, evidence });
    return {
      passed: independent.verdict.passed && independent.verdict.score >= 0.8,
      verdict: independent.verdict,
      usage: independent.usage,
      validEvidenceIds: declared,
    };
  }
}
