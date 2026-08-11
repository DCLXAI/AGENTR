import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspacePath } from "../src/tools/workspace.js";

test("workspace path resolution rejects traversal and symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-workspace-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    assert.equal(await resolveWorkspacePath(workspace, "safe.txt", { createParent: true }), path.join(workspace, "safe.txt"));
    await assert.rejects(resolveWorkspacePath(workspace, "../outside/secret.txt"), /escapes workspace/i);
    await symlink(outside, path.join(workspace, "link"));
    await assert.rejects(resolveWorkspacePath(workspace, "link/secret.txt"), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
