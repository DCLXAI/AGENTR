import path from "node:path";
import type { EvolveConfig } from "./config.js";
import { EvolveError } from "./core/errors.js";
import { ContextCompiler } from "./context/context-compiler.js";
import { ArtifactStore } from "./ledger/artifact-store.js";
import { JsonlLedger } from "./ledger/jsonl-ledger.js";
import { LearningEngine } from "./learning/learning-engine.js";
import { MemoryStore } from "./memory/memory-store.js";
import { InteractiveApprover, type Approver } from "./policy/approver.js";
import { CapabilityAuthority } from "./policy/capability.js";
import { RiskEngine } from "./policy/risk-engine.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses.js";
import type {
  AgentPrompt,
  AgentProvider,
  DecisionResult,
  VerificationInput,
  VerificationResult,
} from "./providers/provider.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import { CheckpointStore } from "./runtime/checkpoint-store.js";
import { SkillStore } from "./skills/skill-store.js";
import { ToolRegistry } from "./tools/registry.js";
import { FinalVerifier } from "./verification/final-verifier.js";

class MissingApiKeyProvider implements AgentProvider {
  public async decide(_prompt: AgentPrompt): Promise<DecisionResult> {
    throw new EvolveError("PROVIDER_AUTH", "OPENAI_API_KEY is required to run or resume an episode");
  }
  public async verify(_input: VerificationInput): Promise<VerificationResult> {
    throw new EvolveError("PROVIDER_AUTH", "OPENAI_API_KEY is required to verify an answer");
  }
}

export interface RuntimeBundle {
  runtime: AgentRuntime;
  ledger: JsonlLedger;
  artifacts: ArtifactStore;
  checkpoints: CheckpointStore;
  memory: MemoryStore;
  skills: SkillStore;
  tools: ToolRegistry;
  provider: AgentProvider;
}

export function createRuntime(
  config: EvolveConfig,
  overrides: { provider?: AgentProvider; approver?: Approver } = {},
): RuntimeBundle {
  const capabilities = new CapabilityAuthority(path.join(config.home, "capability.key"));
  const tools = new ToolRegistry(capabilities, {
    workspace: config.workspace,
    allowedCommands: config.allowedCommands,
  });
  const ledger = new JsonlLedger(path.join(config.home, "episodes.jsonl"));
  const artifacts = new ArtifactStore(config.home);
  const checkpoints = new CheckpointStore(config.home);
  const memory = new MemoryStore(config.home);
  const skills = new SkillStore(config.home);
  const provider =
    overrides.provider ??
    (config.openAiApiKey
      ? new OpenAIResponsesProvider({
          apiKey: config.openAiApiKey,
          model: config.model,
          verifierModel: config.verifierModel,
          reasoningEffort: config.reasoningEffort,
        })
      : new MissingApiKeyProvider());
  const context = new ContextCompiler(memory, skills, tools);
  const verifier = new FinalVerifier(artifacts, provider);
  const learning = new LearningEngine(config.home, skills);
  const risk = new RiskEngine();
  const approver = overrides.approver ?? new InteractiveApprover(config.nonInteractive);
  const runtime = new AgentRuntime({
    provider,
    ledger,
    artifacts,
    checkpoints,
    tools,
    risk,
    approver,
    capabilities,
    context,
    verifier,
    memory,
    skills,
    learning,
  });
  return { runtime, ledger, artifacts, checkpoints, memory, skills, tools, provider };
}
