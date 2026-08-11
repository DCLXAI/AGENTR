import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { EvolveError } from "../core/errors.js";
import type { ExecutorKind, WorkspaceAccess } from "../execution/types.js";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg, stringArrayArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

function enumValue<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) throw new EvolveError("TOOL_ARGS_INVALID", `${label} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function validateSecrets(names: string[]): string[] {
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new EvolveError("TOOL_ARGS_INVALID", `Invalid secret name: ${name}`);
    }
  }
  return [...new Set(names)].sort();
}

export const runProcessTool: ToolDefinition = {
  name: "run_process",
  description:
    "Run an allowlisted executable through the configured executor. Docker is deny-by-default: pinned allowlisted image, no network, read-only root, dropped capabilities, resource limits, and ephemeral file secrets.",
  risk: "execute",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Allowlisted executable name; paths are rejected" },
      args: { type: "array", items: { type: "string" }, maxItems: 128 },
      cwd: { type: "string", description: "Workspace-relative working directory" },
      timeout_ms: { type: "integer", minimum: 100, maximum: 120000 },
      max_output_bytes: { type: "integer", minimum: 1024, maximum: 500000 },
      executor: { type: "string", enum: ["default", "docker", "local"] },
      image: { type: "string", description: "Exact allowlisted sha256-pinned Docker image" },
      network: { type: "string", description: "none or an operator-managed allowlisted Docker network" },
      workspace_access: { type: "string", enum: ["read-only", "read-write"] },
      secrets: { type: "array", items: { type: "string" }, maxItems: 16 },
      memory_mb: { type: "integer", minimum: 64, maximum: 8192 },
      cpus: { type: "number", minimum: 0.1, maximum: 8 },
      pids_limit: { type: "integer", minimum: 16, maximum: 1024 },
      tmpfs_mb: { type: "integer", minimum: 16, maximum: 1024 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, [
      "command",
      "args",
      "cwd",
      "timeout_ms",
      "max_output_bytes",
      "executor",
      "image",
      "network",
      "workspace_access",
      "secrets",
      "memory_mb",
      "cpus",
      "pids_limit",
      "tmpfs_mb",
    ]);
    const command = stringArg(args, "command", { required: true, min: 1, max: 128 }) as string;
    if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
      throw new EvolveError("TOOL_ARGS_INVALID", "command must be an executable name, not a path");
    }
    const executor = enumValue(
      stringArg(args, "executor", { fallback: "default", max: 16 }) as string,
      ["default", "docker", "local"] as const,
      "executor",
    );
    const workspaceAccess = enumValue(
      stringArg(args, "workspace_access", { fallback: "read-only", max: 16 }) as string,
      ["read-only", "read-write"] as const,
      "workspace_access",
    );
    const image = stringArg(args, "image", { max: 512 });
    return {
      command,
      args: stringArrayArg(args, "args", { fallback: [], maxItems: 128, maxItemLength: 10_000 }) as string[],
      cwd: stringArg(args, "cwd", { fallback: ".", max: 4096 }) as string,
      timeout_ms: numberArg(args, "timeout_ms", { fallback: 60_000, min: 100, max: 120_000, integer: true }) as number,
      max_output_bytes: numberArg(args, "max_output_bytes", {
        fallback: 200_000,
        min: 1024,
        max: 500_000,
        integer: true,
      }) as number,
      executor,
      ...(image !== undefined ? { image } : {}),
      network: stringArg(args, "network", { fallback: "none", min: 1, max: 128 }) as string,
      workspace_access: workspaceAccess,
      secrets: validateSecrets(
        stringArrayArg(args, "secrets", { fallback: [], maxItems: 16, maxItemLength: 64 }) as string[],
      ),
      memory_mb: numberArg(args, "memory_mb", { fallback: 512, min: 64, max: 8_192, integer: true }) as number,
      cpus: numberArg(args, "cpus", { fallback: 1, min: 0.1, max: 8 }) as number,
      pids_limit: numberArg(args, "pids_limit", { fallback: 128, min: 16, max: 1_024, integer: true }) as number,
      tmpfs_mb: numberArg(args, "tmpfs_mb", { fallback: 64, min: 16, max: 1_024, integer: true }) as number,
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const command = args.command as string;
    if (!context.allowedCommands.has(command)) {
      throw new EvolveError("COMMAND_NOT_ALLOWED", `${command} is not in EVOLVE_ALLOWED_COMMANDS`);
    }
    const workspace = await resolveWorkspacePath(context.workspace, ".");
    const cwd = await resolveWorkspacePath(workspace, args.cwd as string);
    if (!(await stat(cwd)).isDirectory()) throw new EvolveError("PROCESS_CWD_INVALID", "cwd is not a directory");

    const requestedExecutor = args.executor as "default" | ExecutorKind;
    const result = await context.executors.execute(requestedExecutor, {
      runId: `${context.episodeId}-${randomUUID()}`,
      command,
      args: args.args as string[],
      workspace,
      cwd,
      timeoutMs: args.timeout_ms as number,
      maxOutputBytes: args.max_output_bytes as number,
      workspaceAccess: args.workspace_access as WorkspaceAccess,
      network: args.network as string,
      secretNames: args.secrets as string[],
      limits: {
        memoryMb: args.memory_mb as number,
        cpus: args.cpus as number,
        pids: args.pids_limit as number,
        tmpfsMb: args.tmpfs_mb as number,
      },
      ...(args.image !== undefined ? { image: args.image as string } : {}),
    });

    return {
      success: result.success,
      summary: `${command} exited ${result.timedOut ? "after timeout" : `with code ${String(result.exitCode)}`} via ${result.executor} in ${displayPath(workspace, cwd)}`,
      data: {
        command,
        args: args.args as string[],
        cwd: displayPath(workspace, cwd),
        executor: result.executor,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        truncated: result.truncated,
        duration_ms: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.image !== undefined ? { image: result.image } : {}),
        network: result.network,
        workspace_access: result.workspaceAccess,
        secret_names: result.secretNames,
        execution_receipt: {
          run_id: result.receipt.runId,
          sandbox_id: result.receipt.sandboxId,
          command_hash: result.receipt.commandHash,
          policy_hash: result.receipt.policyHash,
        },
        isolation: {
          boundary: result.isolation.boundary,
          read_only_root: result.isolation.readOnlyRoot,
          capabilities_dropped: result.isolation.capabilitiesDropped,
          no_new_privileges: result.isolation.noNewPrivileges,
          resource_limits: result.isolation.resourceLimits,
          network_policy: result.isolation.networkPolicy,
          secret_delivery: result.isolation.secretDelivery,
        },
      },
    };
  },
};
