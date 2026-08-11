import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sha256Bytes } from "./core/hash.js";
import type { ExecutorKind, ResourceLimits } from "./execution/types.js";
import { defaultEvaluationPolicy } from "./evaluation/metrics.js";
import type { EvaluationPolicy } from "./evaluation/types.js";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

function defaultStateHome(workspace: string): string {
  const stateRoot = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
  return path.join(stateRoot, "evolve-agent", sha256Bytes(workspace).slice(0, 16));
}

function canonicalCandidate(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  const canonicalParent = realpathSync(current);
  return path.resolve(canonicalParent, ...missing);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export interface DockerConfig {
  binary: string;
  defaultImage?: string;
  allowedImages: Set<string>;
  allowedNetworks: Set<string>;
  user: string;
  maximums: ResourceLimits;
  requireRootless: boolean;
}

export interface EvaluationConfig {
  captureCommitted: boolean;
  shadowPercent: number;
  monitorPromoted: boolean;
  canaryMinSamples: number;
  monitorMinSamples: number;
  monitorWindow: number;
  monitorMaxSuccessDrop: number;
  monitorMaxScoreDrop: number;
  monitorMaxTokenRatio: number;
  policy: EvaluationPolicy;
}

export interface EvolveConfig {
  home: string;
  workspace: string;
  model: string;
  verifierModel: string;
  reasoningEffort: ReasoningEffort;
  allowedCommands: Set<string>;
  nonInteractive: boolean;
  openAiApiKey?: string;
  defaultExecutor: ExecutorKind;
  allowLocalExecutor: boolean;
  docker: DockerConfig;
  secretAllowlist: Set<string>;
  secretTtlMs: number;
  leaseTtlMs: number;
  leaseHeartbeatMs: number;
  evaluation: EvaluationConfig;
}

function booleanValue(value: boolean | undefined, environment: string | undefined, fallback: boolean): boolean {
  if (value !== undefined) return value;
  if (environment === undefined) return fallback;
  if (environment === "true") return true;
  if (environment === "false") return false;
  throw new Error(`Expected true or false, received ${environment}`);
}

function nonnegativeValue(value: number | undefined, environment: string | undefined, fallback: number, label: string): number {
  const resolved = value ?? (environment === undefined ? fallback : Number(environment));
  if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${label} must be a non-negative number`);
  return resolved;
}

function boundedValue(
  value: number | undefined,
  environment: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? (environment === undefined ? fallback : Number(environment));
  if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function numberValue(value: number | undefined, environment: string | undefined, fallback: number, label: string): number {
  const resolved = value ?? (environment === undefined ? fallback : Number(environment));
  if (!Number.isFinite(resolved) || resolved <= 0) throw new Error(`${label} must be a positive number`);
  return resolved;
}

function values(source: Iterable<string> | undefined, environment: string | undefined): Set<string> {
  const entries = source ?? (environment ?? "").split(",");
  return new Set([...entries].map((value) => value.trim()).filter(Boolean));
}

export type ConfigOverrides = Partial<
  Omit<EvolveConfig, "allowedCommands" | "secretAllowlist" | "docker" | "evaluation">
> & {
  allowedCommands?: Iterable<string>;
  secretAllowlist?: Iterable<string>;
  evaluation?: Partial<Omit<EvaluationConfig, "policy">> & { policy?: Partial<EvaluationPolicy> };
  docker?: Partial<Omit<DockerConfig, "allowedImages" | "allowedNetworks" | "maximums">> & {
    allowedImages?: Iterable<string>;
    allowedNetworks?: Iterable<string>;
    maximums?: Partial<ResourceLimits>;
  };
};

export function loadConfig(overrides: ConfigOverrides = {}): EvolveConfig {
  const effort = overrides.reasoningEffort ?? process.env.EVOLVE_REASONING_EFFORT ?? "high";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`Invalid reasoning effort: ${effort}`);
  }

  const commands =
    overrides.allowedCommands ??
    (process.env.EVOLVE_ALLOWED_COMMANDS ?? "git,node,npm,npx,pnpm,python,python3,pytest,vitest,tsc").split(",");
  const defaultExecutor = overrides.defaultExecutor ?? process.env.EVOLVE_EXECUTOR ?? "docker";
  if (defaultExecutor !== "docker" && defaultExecutor !== "local") {
    throw new Error(`Invalid executor: ${defaultExecutor}`);
  }
  const allowLocalExecutor = booleanValue(
    overrides.allowLocalExecutor,
    process.env.EVOLVE_ALLOW_LOCAL_EXECUTOR,
    false,
  );
  if (defaultExecutor === "local" && !allowLocalExecutor) {
    throw new Error("EVOLVE_EXECUTOR=local requires EVOLVE_ALLOW_LOCAL_EXECUTOR=true");
  }

  const dockerOverride = overrides.docker ?? {};
  const defaultImage = dockerOverride.defaultImage ?? process.env.EVOLVE_DOCKER_DEFAULT_IMAGE;
  const allowedImages = values(dockerOverride.allowedImages, process.env.EVOLVE_DOCKER_ALLOWED_IMAGES);
  if (defaultImage) allowedImages.add(defaultImage);
  const allowedNetworks = values(dockerOverride.allowedNetworks, process.env.EVOLVE_DOCKER_ALLOWED_NETWORKS);
  allowedNetworks.add("none");

  const maximums: ResourceLimits = {
    memoryMb: numberValue(
      dockerOverride.maximums?.memoryMb,
      process.env.EVOLVE_DOCKER_MAX_MEMORY_MB,
      2_048,
      "EVOLVE_DOCKER_MAX_MEMORY_MB",
    ),
    cpus: numberValue(
      dockerOverride.maximums?.cpus,
      process.env.EVOLVE_DOCKER_MAX_CPUS,
      2,
      "EVOLVE_DOCKER_MAX_CPUS",
    ),
    pids: Math.floor(
      numberValue(
        dockerOverride.maximums?.pids,
        process.env.EVOLVE_DOCKER_MAX_PIDS,
        256,
        "EVOLVE_DOCKER_MAX_PIDS",
      ),
    ),
    tmpfsMb: Math.floor(
      numberValue(
        dockerOverride.maximums?.tmpfsMb,
        process.env.EVOLVE_DOCKER_MAX_TMPFS_MB,
        256,
        "EVOLVE_DOCKER_MAX_TMPFS_MB",
      ),
    ),
  };

  const leaseTtlMs = numberValue(overrides.leaseTtlMs, process.env.EVOLVE_LEASE_TTL_MS, 30_000, "EVOLVE_LEASE_TTL_MS");
  const leaseHeartbeatMs = numberValue(
    overrides.leaseHeartbeatMs,
    process.env.EVOLVE_LEASE_HEARTBEAT_MS,
    10_000,
    "EVOLVE_LEASE_HEARTBEAT_MS",
  );
  if (leaseHeartbeatMs * 2 >= leaseTtlMs) {
    throw new Error("EVOLVE_LEASE_HEARTBEAT_MS must be less than half of EVOLVE_LEASE_TTL_MS");
  }

  const workspace = canonicalCandidate(overrides.workspace ?? process.env.EVOLVE_WORKSPACE ?? ".");
  const home = canonicalCandidate(overrides.home ?? process.env.EVOLVE_HOME ?? defaultStateHome(workspace));
  if (isInside(workspace, home)) {
    throw new Error("EVOLVE_HOME must be outside EVOLVE_WORKSPACE so sandboxed code cannot read agent authority or secret state");
  }

  const evaluationOverride = overrides.evaluation ?? {};
  const evaluationPolicy = defaultEvaluationPolicy({
    ...evaluationOverride.policy,
    minFixtures: Math.floor(
      numberValue(
        evaluationOverride.policy?.minFixtures,
        process.env.EVOLVE_EVAL_MIN_FIXTURES,
        3,
        "EVOLVE_EVAL_MIN_FIXTURES",
      ),
    ),
    repeats: Math.floor(
      numberValue(evaluationOverride.policy?.repeats, process.env.EVOLVE_EVAL_REPEATS, 1, "EVOLVE_EVAL_REPEATS"),
    ),
    maxNewFailures: Math.floor(
      nonnegativeValue(
        evaluationOverride.policy?.maxNewFailures,
        process.env.EVOLVE_EVAL_MAX_NEW_FAILURES,
        0,
        "EVOLVE_EVAL_MAX_NEW_FAILURES",
      ),
    ),
    maxSuccessRegression: boundedValue(
      evaluationOverride.policy?.maxSuccessRegression,
      process.env.EVOLVE_EVAL_MAX_SUCCESS_REGRESSION,
      0,
      "EVOLVE_EVAL_MAX_SUCCESS_REGRESSION",
      0,
      1,
    ),
    maxScoreRegression: boundedValue(
      evaluationOverride.policy?.maxScoreRegression,
      process.env.EVOLVE_EVAL_MAX_SCORE_REGRESSION,
      0.02,
      "EVOLVE_EVAL_MAX_SCORE_REGRESSION",
      0,
      1,
    ),
    minSuccessImprovement: boundedValue(
      evaluationOverride.policy?.minSuccessImprovement,
      process.env.EVOLVE_EVAL_MIN_SUCCESS_IMPROVEMENT,
      0.05,
      "EVOLVE_EVAL_MIN_SUCCESS_IMPROVEMENT",
      0,
      1,
    ),
    minScoreImprovement: boundedValue(
      evaluationOverride.policy?.minScoreImprovement,
      process.env.EVOLVE_EVAL_MIN_SCORE_IMPROVEMENT,
      0.02,
      "EVOLVE_EVAL_MIN_SCORE_IMPROVEMENT",
      0,
      1,
    ),
    maxTokenRegressionRatio: numberValue(
      evaluationOverride.policy?.maxTokenRegressionRatio,
      process.env.EVOLVE_EVAL_MAX_TOKEN_RATIO,
      1.2,
      "EVOLVE_EVAL_MAX_TOKEN_RATIO",
    ),
    maxToolCallRegressionRatio: numberValue(
      evaluationOverride.policy?.maxToolCallRegressionRatio,
      process.env.EVOLVE_EVAL_MAX_TOOL_RATIO,
      1.2,
      "EVOLVE_EVAL_MAX_TOOL_RATIO",
    ),
    efficiencyImprovementRatio: boundedValue(
      evaluationOverride.policy?.efficiencyImprovementRatio,
      process.env.EVOLVE_EVAL_EFFICIENCY_RATIO,
      0.9,
      "EVOLVE_EVAL_EFFICIENCY_RATIO",
      0.01,
      1,
    ),
    confidenceLevel: boundedValue(
      evaluationOverride.policy?.confidenceLevel,
      process.env.EVOLVE_EVAL_CONFIDENCE,
      0.9,
      "EVOLVE_EVAL_CONFIDENCE",
      0.5,
      0.999,
    ),
    bootstrapSamples: Math.floor(
      numberValue(
        evaluationOverride.policy?.bootstrapSamples,
        process.env.EVOLVE_EVAL_BOOTSTRAP_SAMPLES,
        1_000,
        "EVOLVE_EVAL_BOOTSTRAP_SAMPLES",
      ),
    ),
  });
  const evaluation: EvaluationConfig = {
    captureCommitted: booleanValue(
      evaluationOverride.captureCommitted,
      process.env.EVOLVE_EVAL_CAPTURE_COMMITTED,
      false,
    ),
    shadowPercent: boundedValue(
      evaluationOverride.shadowPercent,
      process.env.EVOLVE_EVAL_SHADOW_PERCENT,
      0,
      "EVOLVE_EVAL_SHADOW_PERCENT",
      0,
      100,
    ),
    monitorPromoted: booleanValue(
      evaluationOverride.monitorPromoted,
      process.env.EVOLVE_EVAL_MONITOR_PROMOTED,
      true,
    ),
    canaryMinSamples: Math.floor(
      numberValue(
        evaluationOverride.canaryMinSamples,
        process.env.EVOLVE_EVAL_CANARY_MIN_SAMPLES,
        5,
        "EVOLVE_EVAL_CANARY_MIN_SAMPLES",
      ),
    ),
    monitorMinSamples: Math.floor(
      numberValue(
        evaluationOverride.monitorMinSamples,
        process.env.EVOLVE_EVAL_MONITOR_MIN_SAMPLES,
        10,
        "EVOLVE_EVAL_MONITOR_MIN_SAMPLES",
      ),
    ),
    monitorWindow: Math.floor(
      numberValue(
        evaluationOverride.monitorWindow,
        process.env.EVOLVE_EVAL_MONITOR_WINDOW,
        50,
        "EVOLVE_EVAL_MONITOR_WINDOW",
      ),
    ),
    monitorMaxSuccessDrop: boundedValue(
      evaluationOverride.monitorMaxSuccessDrop,
      process.env.EVOLVE_EVAL_MONITOR_MAX_SUCCESS_DROP,
      0.1,
      "EVOLVE_EVAL_MONITOR_MAX_SUCCESS_DROP",
      0,
      1,
    ),
    monitorMaxScoreDrop: boundedValue(
      evaluationOverride.monitorMaxScoreDrop,
      process.env.EVOLVE_EVAL_MONITOR_MAX_SCORE_DROP,
      0.1,
      "EVOLVE_EVAL_MONITOR_MAX_SCORE_DROP",
      0,
      1,
    ),
    monitorMaxTokenRatio: numberValue(
      evaluationOverride.monitorMaxTokenRatio,
      process.env.EVOLVE_EVAL_MONITOR_MAX_TOKEN_RATIO,
      1.5,
      "EVOLVE_EVAL_MONITOR_MAX_TOKEN_RATIO",
    ),
    policy: evaluationPolicy,
  };
  if (evaluation.monitorWindow < evaluation.monitorMinSamples || evaluation.monitorWindow < evaluation.canaryMinSamples) {
    throw new Error("EVOLVE_EVAL_MONITOR_WINDOW must be at least both EVOLVE_EVAL_MONITOR_MIN_SAMPLES and EVOLVE_EVAL_CANARY_MIN_SAMPLES");
  }

  const apiKey = overrides.openAiApiKey ?? process.env.OPENAI_API_KEY;
  const docker: DockerConfig = {
    binary: dockerOverride.binary ?? process.env.EVOLVE_DOCKER_BINARY ?? "docker",
    ...(defaultImage !== undefined ? { defaultImage } : {}),
    allowedImages,
    allowedNetworks,
    user: dockerOverride.user ?? process.env.EVOLVE_DOCKER_USER ?? "65532:65532",
    maximums,
    requireRootless: booleanValue(
      dockerOverride.requireRootless,
      process.env.EVOLVE_DOCKER_REQUIRE_ROOTLESS,
      false,
    ),
  };

  return {
    home,
    workspace,
    model: overrides.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
    verifierModel: overrides.verifierModel ?? process.env.OPENAI_VERIFIER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
    reasoningEffort: effort as ReasoningEffort,
    allowedCommands: new Set([...commands].map((value) => value.trim()).filter(Boolean)),
    nonInteractive: overrides.nonInteractive ?? process.env.EVOLVE_NON_INTERACTIVE === "true",
    ...(apiKey ? { openAiApiKey: apiKey } : {}),
    defaultExecutor,
    allowLocalExecutor,
    docker,
    secretAllowlist: values(overrides.secretAllowlist, process.env.EVOLVE_SECRET_ALLOWLIST),
    secretTtlMs: numberValue(overrides.secretTtlMs, process.env.EVOLVE_SECRET_TTL_MS, 300_000, "EVOLVE_SECRET_TTL_MS"),
    leaseTtlMs,
    leaseHeartbeatMs,
    evaluation,
  };
}
