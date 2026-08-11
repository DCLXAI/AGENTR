import assert from "node:assert/strict";
import test from "node:test";
import { LocalExecutor } from "../src/execution/local-executor.js";
import type { ProcessRunner } from "../src/execution/process-runner.js";
import type { ExecutionRequest } from "../src/execution/types.js";

const runner: ProcessRunner = {
  async run() {
    return {
      code: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    };
  },
};

function request(): ExecutionRequest {
  return {
    runId: "local-run",
    command: "node",
    args: ["--version"],
    workspace: process.cwd(),
    cwd: process.cwd(),
    timeoutMs: 1_000,
    maxOutputBytes: 2_000,
    workspaceAccess: "read-only",
    network: "none",
    secretNames: [],
    limits: { memoryMb: 128, cpus: 1, pids: 32, tmpfsMb: 16 },
  };
}

test("local executor requires explicit acknowledgement of unenforceable host access", async () => {
  const executor = new LocalExecutor(runner);
  await assert.rejects(executor.execute(request()), /cannot enforce network isolation/);

  const hostNetwork = { ...request(), network: "host" };
  await assert.rejects(executor.execute(hostNetwork), /cannot enforce a read-only workspace/);

  const explicit = { ...hostNetwork, workspaceAccess: "read-write" as const };
  const result = await executor.execute(explicit);
  assert.equal(result.success, true);
  assert.equal(result.isolation.boundary, "none");
  assert.equal(result.workspaceAccess, "read-write");
});
