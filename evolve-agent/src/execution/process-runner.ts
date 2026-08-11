import { spawn } from "node:child_process";

export interface ProcessRunRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProcessRunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ProcessRunner {
  run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

function terminate(pid: number | undefined, signal: NodeJS.Signals, detached: boolean): void {
  if (pid === undefined) return;
  try {
    process.kill(detached ? -pid : pid, signal);
  } catch {
    // The process may already have exited or the platform may reject group signals.
  }
}

export class NodeProcessRunner implements ProcessRunner {
  public async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    const startedAt = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      detached,
      env: request.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const stopProcess = (): void => {
      terminate(child.pid, "SIGTERM", detached);
      if (forceTimer === undefined) {
        forceTimer = setTimeout(() => terminate(child.pid, "SIGKILL", detached), 1_000);
        forceTimer.unref();
      }
    };

    const append = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = request.maxOutputBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        stopProcess();
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) {
        truncated = true;
        stopProcess();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      stopProcess();
    }, request.timeoutMs);
    timeout.unref();

    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => {
      clearTimeout(timeout);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
    });

    return {
      code: result.code,
      signal: result.signal,
      timedOut,
      truncated,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      durationMs: Date.now() - startedAt,
    };
  }
}
