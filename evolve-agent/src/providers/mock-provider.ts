import type {
  AgentDecision,
  AgentPrompt,
  AgentProvider,
  DecisionResult,
  VerificationInput,
  VerificationResult,
  VerificationVerdict,
} from "./provider.js";

export type MockDecision = AgentDecision | ((prompt: AgentPrompt) => AgentDecision);

export class MockProvider implements AgentProvider {
  public readonly prompts: AgentPrompt[] = [];
  public readonly verifications: VerificationInput[] = [];

  public constructor(
    private readonly decisions: MockDecision[],
    private readonly verdicts: VerificationVerdict[] = [{ passed: true, score: 1, feedback: "accepted" }],
  ) {}

  public async decide(prompt: AgentPrompt): Promise<DecisionResult> {
    this.prompts.push(prompt);
    const next = this.decisions.shift();
    if (!next) throw new Error("MockProvider decision queue exhausted");
    const decision = typeof next === "function" ? next(prompt) : next;
    return {
      decision,
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      providerResponseId: `mock_${this.prompts.length}`,
    };
  }

  public async verify(input: VerificationInput): Promise<VerificationResult> {
    this.verifications.push(input);
    const verdict = this.verdicts.shift() ?? { passed: true, score: 1, feedback: "accepted" };
    return {
      verdict,
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      providerResponseId: `mock_verify_${this.verifications.length}`,
    };
  }
}
