import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { EvolveError } from "../core/errors.js";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg, stringArrayArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

function safeEnvironment(workspace: string): NodeJS.ProcessEnv {
  const keys = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "CI"];
  const output: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) output[key] = value;
  }
  output.HOME = workspace;
  output.NO_COLOR = "1";
  return output;
}

export const runProcessTool: ToolDefinition = {
  name: "run_process",
  description:
    "Run one allowlisted executable without a shell, in a workspace directory, with a timeout and capped output.",
  risk: "execute",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Allowlisted executable name; paths are rejected" },
      args: { type: "array", items: { type: "string" }, maxItems: 128 },
      cwd: { type: "string", description: "Workspace-relative working directory" },
      timeout_ms: { type: "integer", minimum: 100, maximum: 120000 },
      max_output_bytes: { type: "integer", minimum: 1024, maximum: 500000 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["command", "args", "cwd", "timeout_ms", "max_output_bytes"]);
    const command = stringArg(args, "command", { required: true, min: 1, max: 128 }) as string;
    if (command.includes("/") || command.includes("\\") || command === "." || command === "..") {
      throw new EvolveError("TOOL_ARGS_INVALID", "command must be an executable name, not a path");
    }
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
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const command = args.command as string;
    if (!context.allowedCommands.has(command)) {
      throw new EvolveError("COMMAND_NOT_ALLOWED", `${command} is not in EVOLVE_ALLOWED_COMMANDS`);
    }
    const cwd = await resolveWorkspacePath(context.workspace, args.cwd as string);
    if (!(await stat(cwd)).isDirectory()) throw new EvolveError("PROCESS_CWD_INVALID", "cwd is not a directory");

    const maxBytes = args.max_output_bytes as number;
    let capturedBytes = 0;
    let truncated = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const append = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = maxBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
    };

    const child = spawn(command, args.args as string[], {
      cwd,
      shell: false,
      windowsHide: true,
      env: safeEnvironment(context.workspace),
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => append(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderrChunks, chunk));

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, args.timeout_ms as number);
    timeout.unref();

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    const success = !timedOut && result.code === 0;
    return {
      success,
      summary: `${command} exited ${timedOut ? "after timeout" : `with code ${String(result.code)}`} in ${displayPath(context.workspace, cwd)}`,
      data: {
        command,
        args: args.args as string[],
        cwd: displayPath(context.workspace, cwd),
        exit_code: result.code,
        signal: result.signal,
        timed_out: timedOut,
        truncated,
        stdout,
        stderr,
      },
    };
  },
};
