import path from "node:path";
import type { EvolveConfig } from "./config.js";
import { EvolveError } from "./core/errors.js";
import { ContextCompiler } from "./context/context-compiler.js";
import { DockerExecutor } from "./execution/docker-executor.js";
import { ExecutorRegistry } from "./execution/executor-registry.js";
import { ImagePolicy } from "./execution/image-policy.js";
import { LocalExecutor } from "./execution/local-executor.js";
import { DockerNetworkPolicy } from "./execution/network-policy.js";
import { NodeProcessRunner, type ProcessRunner } from "./execution/process-runner.js";
import type { Executor } from "./execution/types.js";
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
import { EpisodeLeaseManager } from "./runtime/lease-manager.js";
import { FileSecretBroker, type SecretBroker, type SecretSource } from "./secrets/secret-broker.js";
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
  executors: ExecutorRegistry;
  secrets: SecretBroker;
  leases: EpisodeLeaseManager;
}

export interface RuntimeOverrides {
  provider?: AgentProvider;
  approver?: Approver;
  processRunner?: ProcessRunner;
  secretSource?: SecretSource;
  secretBroker?: SecretBroker;
  executors?: ExecutorRegistry;
  leases?: EpisodeLeaseManager;
}

function createExecutors(
  config: EvolveConfig,
  runner: ProcessRunner,
  secrets: SecretBroker,
): ExecutorRegistry {
  const executors: Executor[] = [
    new DockerExecutor(runner, secrets, {
      binary: config.docker.binary,
      user: config.docker.user,
      imagePolicy: new ImagePolicy(config.docker.allowedImages, config.docker.defaultImage),
      networkPolicy: new DockerNetworkPolicy(config.docker.allowedNetworks),
      maximums: config.docker.maximums,
      requireRootless: config.docker.requireRootless,
    }),
  ];
  if (config.allowLocalExecutor) executors.push(new LocalExecutor(runner));
  return new ExecutorRegistry(config.defaultExecutor, executors);
}

export function createRuntime(config: EvolveConfig, overrides: RuntimeOverrides = {}): RuntimeBundle {
  const runner = overrides.processRunner ?? new NodeProcessRunner();
  const secrets =
    overrides.secretBroker ??
    new FileSecretBroker(
      path.join(config.home, "runtime", "secrets"),
      config.secretAllowlist,
      config.secretTtlMs,
      overrides.secretSource,
    );
  const executors = overrides.executors ?? createExecutors(config, runner, secrets);
  const leases =
    overrides.leases ??
    new EpisodeLeaseManager(config.home, {
      ttlMs: config.leaseTtlMs,
      heartbeatMs: config.leaseHeartbeatMs,
    });

  const capabilities = new CapabilityAuthority(path.join(config.home, "capability.key"));
  const tools = new ToolRegistry(capabilities, {
    workspace: config.workspace,
    allowedCommands: config.allowedCommands,
    executors,
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
    leases,
  });
  return { runtime, ledger, artifacts, checkpoints, memory, skills, tools, provider, executors, secrets, leases };
}
