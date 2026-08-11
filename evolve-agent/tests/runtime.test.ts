import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/factory.js";
import { StaticApprover } from "../src/policy/approver.js";
import { MockProvider, type MockDecision } from "../src/providers/mock-provider.js";
import type { AgentPrompt, FinalDecision } from "../src/providers/provider.js";

function latestEvidence(prompt: AgentPrompt): string {
  const evidence = prompt.observations.findLast((observation) => observation.evidenceId)?.evidenceId;
  assert.ok(evidence, "expected a tool evidence ID in the next prompt");
  return evidence;
}

function evidenceFinal(text: string, memory = false): MockDecision {
  return (prompt): FinalDecision => {
    const evidence = latestEvidence(prompt);
    return {
      kind: "final",
      answer: `${text} [evidence:${evidence}]`,
      evidenceIds: [evidence],
      memoryProposals: memory
        ? [
            {
              text: "The inspected workspace contains the requested source file.",
              tags: ["workspace", "inspection"],
              confidence: 0.9,
              evidenceIds: [evidence],
            },
          ]
        : [],
    };
  };
}

async function setup(decisions: MockDecision[], approver = new StaticApprover(true)) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-runtime-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const provider = new MockProvider(decisions);
  const config = loadConfig({ home, workspace, allowedCommands: ["node"], nonInteractive: true });
  const bundle = createRuntime(config, { provider, approver });
  return { root, workspace, home, provider, bundle };
}

test("runtime commits only after tool evidence and independent verification", async () => {
  const environment = await setup(
    [
      { kind: "tool", toolName: "read_file", args: { path: "note.txt" }, rationale: "Inspect the file" },
      evidenceFinal("The file contains alpha.", true),
    ],
  );
  try {
    await writeFile(path.join(environment.workspace, "note.txt"), "alpha\n", { encoding: "utf8", flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(environment.workspace, { recursive: true });
        await writeFile(path.join(environment.workspace, "note.txt"), "alpha\n", "utf8");
        return;
      }
      throw error;
    });
    const result = await environment.bundle.runtime.run({
      goal: "Read note.txt and report its content.",
      requestedTools: ["read_file"],
      successCriteria: ["The answer cites the read_file evidence"],
    });
    assert.equal(result.status, "committed");
    assert.equal(result.toolCalls, 1);
    assert.match(result.answer ?? "", /\[evidence:ev_[a-f0-9]{24}\]/);
    assert.equal(environment.provider.verifications.length, 1);
    assert.deepEqual(await environment.bundle.ledger.verify(), { valid: true, events: (await environment.bundle.ledger.readAll()).length });
    assert.equal((await environment.bundle.memory.list()).length, 1);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("invented evidence is rejected before the independent verifier runs", async () => {
  const fake = "ev_ffffffffffffffffffffffff";
  const environment = await setup([
    {
      kind: "final",
      answer: `Fabricated claim [evidence:${fake}]`,
      evidenceIds: [fake],
      memoryProposals: [],
    },
    { kind: "final", answer: "No external facts are needed for this response.", evidenceIds: [], memoryProposals: [] },
  ]);
  try {
    const result = await environment.bundle.runtime.run({
      goal: "Return a short acknowledgement.",
      requestedTools: [],
      budget: { maxTurns: 3 },
    });
    assert.equal(result.status, "committed");
    assert.equal(environment.provider.prompts.length, 2);
    assert.equal(environment.provider.verifications.length, 1);
    const events = await environment.bundle.ledger.forEpisode(result.episodeId);
    assert.ok(events.some((event) => event.type === "verification.rejected"));
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("denied approval prevents file mutation and allows a safe final response", async () => {
  const environment = await setup(
    [
      {
        kind: "tool",
        toolName: "write_file",
        args: { path: "blocked.txt", content: "must not exist", create_only: true },
        rationale: "Attempt a write",
      },
      {
        kind: "final",
        answer: "The requested write was not performed because approval was denied.",
        evidenceIds: [],
        memoryProposals: [],
      },
    ],
    new StaticApprover(false),
  );
  try {
    const result = await environment.bundle.runtime.run({
      goal: "Create blocked.txt only if approved.",
      requestedTools: ["write_file"],
    });
    assert.equal(result.status, "committed");
    assert.equal(result.toolCalls, 0);
    await assert.rejects(readFile(path.join(environment.workspace, "blocked.txt"), "utf8"), /ENOENT/);
    const events = await environment.bundle.ledger.forEpisode(result.episodeId);
    assert.ok(events.some((event) => event.type === "approval.denied"));
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("turn budget stops a loop durably after the allowed turn", async () => {
  const environment = await setup([
    { kind: "tool", toolName: "read_file", args: { path: "note.txt" }, rationale: "Read once" },
  ]);
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(environment.workspace, { recursive: true });
    await writeFile(path.join(environment.workspace, "note.txt"), "alpha", "utf8");
    const result = await environment.bundle.runtime.run({
      goal: "Read note.txt but stop after one model turn.",
      requestedTools: ["read_file"],
      budget: { maxTurns: 1 },
    });
    assert.equal(result.status, "budget_exhausted");
    assert.equal(result.turns, 1);
    assert.equal(result.toolCalls, 1);
    const checkpoint = await environment.bundle.checkpoints.load(result.episodeId);
    assert.equal(checkpoint.status, "budget_exhausted");
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});

test("repeated committed flows create only an inactive skill candidate", async () => {
  const environment = await setup([
    { kind: "tool", toolName: "read_file", args: { path: "note.txt" }, rationale: "Inspect" },
    evidenceFinal("First inspection complete."),
    { kind: "tool", toolName: "read_file", args: { path: "note.txt" }, rationale: "Inspect" },
    evidenceFinal("Second inspection complete."),
  ]);
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(environment.workspace, { recursive: true });
    await writeFile(path.join(environment.workspace, "note.txt"), "alpha", "utf8");
    const first = await environment.bundle.runtime.run({
      goal: "Inspect note.txt for run one.",
      requestedTools: ["read_file"],
    });
    const second = await environment.bundle.runtime.run({
      goal: "Inspect note.txt for run two.",
      requestedTools: ["read_file"],
    });
    assert.equal(first.status, "committed");
    assert.equal(second.status, "committed");
    const skills = await environment.bundle.skills.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.status, "candidate");
    assert.equal(skills[0]?.supportingEpisodes.length, 2);
    assert.equal((await environment.bundle.skills.promoted()).length, 0);
  } finally {
    await rm(environment.root, { recursive: true, force: true });
  }
});
