import path from "node:path";
import { sha256Bytes, sha256Json } from "../core/hash.js";
import { EvolveError } from "../core/errors.js";
import type { SecretBroker, SecretMount } from "../secrets/secret-broker.js";
import { ImagePolicy } from "./image-policy.js";
import { DockerNetworkPolicy } from "./network-policy.js";
import type { ProcessRunner, ProcessRunResult } from "./process-runner.js";
import { dockerClientEnvironment } from "./safe-environment.js";
import type { Executor, ExecutorProbe, ExecutionRequest, ExecutionResult, ResourceLimits } from "./types.js";

export interface DockerExecutorOptions {
  binary: string;
  user: string;
  imagePolicy: ImagePolicy;
  networkPolicy: DockerNetworkPolicy;
  maximums: ResourceLimits;
  requireRootless: boolean;
}

function within(limit: number, maximum: number, label: string): number {
  if (!Number.isFinite(limit) || limit <= 0 || limit > maximum) {
    throw new EvolveError("EXECUTION_LIMIT_DENIED", `${label} must be positive and no greater than ${maximum}`);
  }
  return limit;
}

function mountValue(value: string): string {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes(",")) {
    throw new EvolveError("DOCKER_MOUNT_INVALID", "Docker mount path contains a forbidden character");
  }
  return value;
}

function containerWorkdir(workspace: string, cwd: string): string {
  const relative = path.relative(workspace, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new EvolveError("PROCESS_CWD_INVALID", "cwd escapes the configured workspace");
  }
  return relative === "" ? "/workspace" : `/workspace/${relative.split(path.sep).join("/")}`;
}

function containerName(runId: string): string {
  return `evolve-${sha256Bytes(runId).slice(0, 24)}`;
}

function resourceArgs(limits: ResourceLimits, maximums: ResourceLimits): string[] {
  const memoryMb = Math.floor(within(limits.memoryMb, maximums.memoryMb, "memory_mb"));
  const cpus = within(limits.cpus, maximums.cpus, "cpus");
  const pids = Math.floor(within(limits.pids, maximums.pids, "pids_limit"));
  const tmpfsMb = Math.floor(within(limits.tmpfsMb, maximums.tmpfsMb, "tmpfs_mb"));
  return [
    "--memory",
    `${memoryMb}m`,
    "--memory-swap",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    String(pids),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${tmpfsMb}m`,
  ];
}

export function buildDockerRunArgs(input: {
  request: ExecutionRequest;
  image: string;
  network: string;
  networkEnforcement: string;
  user: string;
  containerName: string;
  secretMounts: SecretMount[];
  maximums: ResourceLimits;
}): string[] {
  const workspaceMode = input.request.workspaceAccess === "read-only" ? ",readonly" : "";
  const args = [
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--name",
    input.containerName,
    "--hostname",
    "evolve-sandbox",
    "--stop-timeout",
    "1",
    "--ipc",
    "none",
    "--label",
    `ai.evolve.run=${input.request.runId}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    input.network,
    "--user",
    input.user,
    "--workdir",
    containerWorkdir(input.request.workspace, input.request.cwd),
    "--ulimit",
    "nofile=1024:1024",
    "--ulimit",
    "core=0:0",
    "--log-driver",
    "none",
    ...resourceArgs(input.request.limits, input.maximums),
    "--tmpfs",
    "/run:rw,nosuid,nodev,noexec,size=16m",
    "--mount",
    `type=bind,src=${mountValue(input.request.workspace)},dst=/workspace${workspaceMode}`,
    "--env",
    "HOME=/tmp/home",
    "--env",
    "NO_COLOR=1",
    "--env",
    "CI=1",
    "--env",
    `EVOLVE_NETWORK_POLICY=${input.networkEnforcement}`,
  ];

  for (const secret of input.secretMounts) {
    args.push(
      "--mount",
      `type=bind,src=${mountValue(secret.hostPath)},dst=${secret.containerPath},readonly`,
      "--env",
      `${secret.name}_FILE=${secret.containerPath}`,
    );
  }

  args.push(input.image, input.request.command, ...input.request.args);
  return args;
}

function parsedSecurityOptions(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // Fall through to a conservative single-string representation.
  }
  return output ? [output] : [];
}

function hasSecurityOption(options: string[], expected: string): boolean {
  return options.some((item) => item.toLowerCase().includes(expected));
}

export class DockerExecutor implements Executor {
  public readonly kind = "docker" as const;

  public constructor(
    private readonly runner: ProcessRunner,
    private readonly secrets: SecretBroker,
    private readonly options: DockerExecutorOptions,
  ) {
    const match = /^(\d+):(\d+)$/.exec(options.user);
    if (!match || match[1] === "0" || match[2] === "0") {
      throw new EvolveError("DOCKER_USER_INVALID", "EVOLVE_DOCKER_USER must be a non-root numeric uid:gid");
    }
  }

  private async cleanup(name: string, workspace: string): Promise<void> {
    try {
      await this.runner.run({
        command: this.options.binary,
        args: ["rm", "-f", name],
        cwd: workspace,
        env: dockerClientEnvironment(),
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });
    } catch {
      // The primary execution result remains authoritative. Orphan cleanup is best effort.
    }
  }

  public async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const image = this.options.imagePolicy.resolve(request.image);
    const network = this.options.networkPolicy.resolve(request.network);
    const name = containerName(request.runId);
    const secretLease = await this.secrets.materialize(request.runId, request.secretNames);
    let result: ProcessRunResult | undefined;
    try {
      const args = buildDockerRunArgs({
        request,
        image,
        network: network.name,
        networkEnforcement: network.enforcement,
        user: this.options.user,
        containerName: name,
        secretMounts: secretLease.mounts,
        maximums: this.options.maximums,
      });
      result = await this.runner.run({
        command: this.options.binary,
        args,
        cwd: request.workspace,
        env: dockerClientEnvironment(),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
      });
    } finally {
      await this.cleanup(name, request.workspace);
      await secretLease.release();
    }

    if (!result) throw new EvolveError("DOCKER_EXECUTION_FAILED", "Docker execution produced no result");
    return {
      executor: this.kind,
      success: !result.timedOut && !result.truncated && result.code === 0,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: secretLease.redact(result.stdout),
      stderr: secretLease.redact(result.stderr),
      durationMs: result.durationMs,
      image,
      network: network.name,
      workspaceAccess: request.workspaceAccess,
      secretNames: [...request.secretNames].sort(),
      receipt: {
        runId: request.runId,
        sandboxId: name,
        commandHash: sha256Json({ command: request.command, args: request.args }),
        policyHash: sha256Json({
          executor: this.kind,
          image,
          network: network.name,
          networkEnforcement: network.enforcement,
          workspaceAccess: request.workspaceAccess,
          secretNames: [...request.secretNames].sort(),
          limits: request.limits,
          user: this.options.user,
          readOnlyRoot: true,
          capabilitiesDropped: true,
          noNewPrivileges: true,
        }),
      },
      isolation: {
        boundary: "docker-container",
        readOnlyRoot: true,
        capabilitiesDropped: true,
        noNewPrivileges: true,
        resourceLimits: true,
        networkPolicy: network.enforcement,
        secretDelivery: request.secretNames.length > 0 ? "ephemeral-read-only-files" : "none",
      },
    };
  }

  public async probe(): Promise<ExecutorProbe> {
    const version = await this.runner.run({
      command: this.options.binary,
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd: process.cwd(),
      env: dockerClientEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
    });
    if (version.code !== 0 || version.timedOut) {
      return {
        kind: this.kind,
        available: false,
        ready: false,
        summary: "Docker daemon is unavailable",
        warnings: [version.stderr.trim()].filter(Boolean),
        details: { binary: this.options.binary },
      };
    }

    const info = await this.runner.run({
      command: this.options.binary,
      args: ["info", "--format", "{{json .SecurityOptions}}"],
      cwd: process.cwd(),
      env: dockerClientEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
    });
    const securityOptions = info.code === 0 ? parsedSecurityOptions(info.stdout.trim()) : [];
    const rootless = hasSecurityOption(securityOptions, "rootless");
    const seccomp = hasSecurityOption(securityOptions, "seccomp");
    const cgroup = await this.runner.run({
      command: this.options.binary,
      args: ["info", "--format", "{{.CgroupVersion}}"],
      cwd: process.cwd(),
      env: dockerClientEnvironment(),
      timeoutMs: 10_000,
      maxOutputBytes: 16_384,
    });
    const cgroupVersion = cgroup.code === 0 ? cgroup.stdout.trim() : "unknown";
    const cgroupAvailable = cgroupVersion === "1" || cgroupVersion === "2";
    const resourceLimitsReady = cgroupAvailable && (!rootless || cgroupVersion === "2");
    const defaultImage = this.options.imagePolicy.getDefault();
    let imageReady = false;
    if (defaultImage) {
      const inspect = await this.runner.run({
        command: this.options.binary,
        args: ["image", "inspect", "--format", "{{.Id}}", defaultImage],
        cwd: process.cwd(),
        env: dockerClientEnvironment(),
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      });
      imageReady = inspect.code === 0 && !inspect.timedOut;
    }

    const warnings: string[] = [];
    if (!rootless) warnings.push("Docker daemon is not reporting rootless mode; use rootless Docker or Docker Desktop's VM boundary.");
    if (!seccomp) warnings.push("Docker is not reporting the default seccomp security option; hardened readiness is blocked.");
    if (!resourceLimitsReady) warnings.push("A supported cgroup boundary is required; rootless Docker specifically needs cgroup v2.");
    if (!defaultImage) warnings.push("EVOLVE_DOCKER_DEFAULT_IMAGE is not configured.");
    else if (!imageReady) warnings.push("The pinned default image is not present locally; --pull never prevents implicit downloads.");
    if (this.options.requireRootless && !rootless) warnings.push("EVOLVE_DOCKER_REQUIRE_ROOTLESS=true blocks hardened readiness.");
    const ready = Boolean(
      defaultImage &&
        imageReady &&
        resourceLimitsReady &&
        seccomp &&
        (!this.options.requireRootless || rootless),
    );
    return {
      kind: this.kind,
      available: true,
      ready,
      summary: ready ? "Docker hardened execution is ready" : "Docker is available but hardened execution needs configuration",
      warnings,
      details: {
        binary: this.options.binary,
        server_version: version.stdout.trim() || null,
        rootless,
        seccomp,
        cgroup_version: cgroupVersion,
        resource_limits_ready: resourceLimitsReady,
        default_image_configured: Boolean(defaultImage),
        default_image_present: imageReady,
        allowed_images: this.options.imagePolicy.list().length,
        allowed_networks: this.options.networkPolicy.list().length,
      },
    };
  }
}
