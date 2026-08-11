import assert from "node:assert/strict";
import test from "node:test";
import { NodeProcessRunner } from "../src/execution/process-runner.js";

test("process runner terminates output floods at the evidence limit", async () => {
  const runner = new NodeProcessRunner();
  const result = await runner.run({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(10_000_000)); setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    timeoutMs: 5_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 1_024);
  assert.ok(result.durationMs < 5_000, `output cap should stop execution before timeout, got ${result.durationMs} ms`);
});
