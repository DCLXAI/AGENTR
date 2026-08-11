import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/factory.js";
import type { ProcessRunner, ProcessRunRequest, ProcessRunResult } from "../src/execution/process-runner.js";
import { StaticApprover } from "../src/policy/approver.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import type { AgentPrompt, FinalDecision } from "../src/providers/provider.js";
import type { JsonValue } from "../src/core/types.js";

const IMAGE = `node:22-bookworm-slim@sha256:${"e".repeat(64)}`;

class DockerRunner implements ProcessRunner {
  public readonly calls: ProcessRunRequest[] = [];
  public async run(input: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(input);
    return {
      code: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      stdout: input.args[0] === "run" ? "v22.6.0\n" : "",
      stderr: "",
      durationMs: 3,
    };
  }
}

function finalFromEvidence(prompt: AgentPrompt): FinalDecision {
  const evidence = prompt.observations.findLast((observation) => observation.evidenceId)?.evidenceId;
  assert.ok(evidence);
  return {
    kind: "final",
    answer: `The isolated process reported Node v22.6.0. [evidence:${evidence}]`,
    evidenceIds: [evidence],
    memoryProposals: [],
  };
}

test("runtime carries exact approval through Docker execution, evidence, and final verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-hardened-runtime-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "state");
  await mkdir(workspace, { recursive: true });
  const runner = new DockerRunner();
  const provider = new MockProvider([
    {
      kind: "tool",
      toolName: "run_process",
      args: {
        command: "node",
        args: ["--version"],
        executor: "docker",
        image: IMAGE,
        network: "none",
        workspace_access: "read-only",
        memory_mb: 256,
        cpus: 0.5,
        pids_limit: 32,
        tmpfs_mb: 32,
      },
      rationale: "Verify the runtime version in the isolated executor",
    },
    finalFromEvidence,
  ]);

  try {
    const config = loadConfig({
      home,
      workspace,
      allowedCommands: ["node"],
      docker: {
        defaultImage: IMAGE,
        allowedImages: [IMAGE],
        maximums: { memoryMb: 512, cpus: 1, pids: 64, tmpfsMb: 64 },
      },
      nonInteractive: true,
    });
    const bundle = createRuntime(config, {
      provider,
      approver: new StaticApprover(true),
      processRunner: runner,
    });
    const result = await bundle.runtime.run({
      goal: "Report the Node version using isolated execution.",
      requestedTools: ["run_process"],
      successCriteria: ["The version is supported by run_process evidence"],
    });

    assert.equal(result.status, "committed");
    assert.equal(result.toolCalls, 1);
    assert.equal(runner.calls.length, 2, "docker run and orphan cleanup");
    assert.ok(runner.calls[0]?.args.includes("--read-only"));
    assert.ok(runner.calls[0]?.args.includes("no-new-privileges:true"));

    const evidence = await bundle.artifacts.getEvidence(result.evidenceIds[0] as string);
    assert.ok(evidence);
    const artifact = (await bundle.artifacts.readArtifact(evidence.artifactHash)) as Record<string, JsonValue>;
    assert.equal(artifact.executor, "docker");
    assert.equal(artifact.network, "none");
    assert.equal(artifact.workspace_access, "read-only");
    const receipt = artifact.execution_receipt as Record<string, JsonValue>;
    assert.equal(typeof receipt.command_hash, "string");
    assert.equal(typeof receipt.policy_hash, "string");

    const events = await bundle.ledger.forEpisode(result.episodeId);
    assert.ok(events.some((event) => event.type === "approval.granted"));
    assert.ok(events.some((event) => event.type === "tool.executed"));
    assert.ok(events.some((event) => event.type === "episode.committed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
