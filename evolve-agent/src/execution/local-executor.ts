import { EvolveError } from "../core/errors.js";
import { sha256Bytes, sha256Json } from "../core/hash.js";
import { safeEnvironment } from "./safe-environment.js";
import type { Executor, ExecutorProbe, ExecutionRequest, ExecutionResult } from "./types.js";
import type { ProcessRunner } from "./process-runner.js";

export class LocalExecutor implements Executor {
  public readonly kind = "local" as const;

  public constructor(private readonly runner: ProcessRunner) {}

  public async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (request.image !== undefined) throw new EvolveError("LOCAL_IMAGE_INVALID", "The local executor does not accept images");
    if (request.secretNames.length > 0) {
      throw new EvolveError("LOCAL_SECRETS_DENIED", "Secrets are available only through the isolated Docker executor");
    }
    if (request.network !== "host") {
      throw new EvolveError(
        "LOCAL_NETWORK_UNENFORCEABLE",
        "The local executor cannot enforce network isolation; request network=host explicitly or use Docker",
      );
    }
    if (request.workspaceAccess !== "read-write") {
      throw new EvolveError(
        "LOCAL_WORKSPACE_UNENFORCEABLE",
        "The local executor cannot enforce a read-only workspace; request workspace_access=read-write explicitly or use Docker",
      );
    }

    const result = await this.runner.run({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: safeEnvironment(request.workspace),
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
    return {
      executor: this.kind,
      success: !result.timedOut && !result.truncated && result.code === 0,
      exitCode: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
      truncated: result.truncated,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      network: request.network,
      workspaceAccess: "read-write",
      secretNames: [],
      receipt: {
        runId: request.runId,
        sandboxId: `local-${sha256Bytes(request.runId).slice(0, 24)}`,
        commandHash: sha256Json({ command: request.command, args: request.args }),
        policyHash: sha256Json({
          executor: this.kind,
          network: request.network,
          workspaceAccess: "read-write",
          isolation: false,
        }),
      },
      isolation: {
        boundary: "none",
        readOnlyRoot: false,
        capabilitiesDropped: false,
        noNewPrivileges: false,
        resourceLimits: false,
        networkPolicy: "unenforced-host-network",
        secretDelivery: "disabled",
      },
    };
  }

  public async probe(): Promise<ExecutorProbe> {
    return {
      kind: this.kind,
      available: true,
      ready: true,
      summary: "Local execution is available but is not an isolation boundary",
      warnings: [
        "Commands run with the current host user's permissions.",
        "Network and read-only workspace policies cannot be enforced.",
      ],
      details: { isolation: false },
    };
  }
}
