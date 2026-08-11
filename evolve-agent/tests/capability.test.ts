import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityAuthority } from "../src/policy/capability.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function temporary(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

test("capability tokens bind exact arguments and expire", async () => {
  const root = await temporary("evolve-capability-");
  try {
    const authority = new CapabilityAuthority(path.join(root, "capability.key"));
    const args = { path: "note.txt", content: "alpha", create_only: true };
    const token = await authority.issue({ episodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa", toolName: "write_file", args, ttlMs: 1_000 });
    await authority.verify(token, { episodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa", toolName: "write_file", args });
    await assert.rejects(
      authority.verify(token, {
        episodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
        toolName: "write_file",
        args: { ...args, content: "changed" },
      }),
      /arguments changed/i,
    );
    await assert.rejects(
      authority.verify(token, {
        episodeId: "ep_aaaaaaaaaaaaaaaaaaaaaaaa",
        toolName: "write_file",
        args,
        now: Date.now() + 10_000,
      }),
      /expired/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry revalidates the exact approved action before execution", async () => {
  const root = await temporary("evolve-registry-");
  try {
    const workspace = path.join(root, "workspace");
    const authority = new CapabilityAuthority(path.join(root, "capability.key"));
    const registry = new ToolRegistry(authority, { workspace, allowedCommands: new Set(["node"]) });
    const validated = registry.get("write_file").validate({ path: "note.txt", content: "alpha", create_only: true });
    const token = await authority.issue({
      episodeId: "ep_bbbbbbbbbbbbbbbbbbbbbbbb",
      toolName: "write_file",
      args: validated,
    });
    await assert.rejects(
      registry.execute({
        episodeId: "ep_bbbbbbbbbbbbbbbbbbbbbbbb",
        toolName: "write_file",
        rawArgs: { path: "note.txt", content: "beta", create_only: true },
        capabilityToken: token,
      }),
      /arguments changed/i,
    );
    await registry.execute({
      episodeId: "ep_bbbbbbbbbbbbbbbbbbbbbbbb",
      toolName: "write_file",
      rawArgs: validated,
      capabilityToken: token,
    });
    assert.equal(await readFile(path.join(workspace, "note.txt"), "utf8"), "alpha");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
