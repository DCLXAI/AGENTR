import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createRuntime } from "../src/factory.js";

const IMAGE = `node:22@sha256:${"c".repeat(64)}`;

test("hardened execution is Docker-first and local execution is explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-config-test-"));
  try {
    const hardened = loadConfig({ home: path.join(root, "home"), workspace: path.join(root, "workspace") });
    assert.equal(hardened.defaultExecutor, "docker");
    assert.equal(hardened.allowLocalExecutor, false);
    assert.throws(
      () => loadConfig({ defaultExecutor: "local", allowLocalExecutor: false }),
      /requires EVOLVE_ALLOW_LOCAL_EXECUTOR=true/,
    );

    const local = loadConfig({ defaultExecutor: "local", allowLocalExecutor: true });
    assert.equal(local.defaultExecutor, "local");
    assert.equal(local.allowLocalExecutor, true);
    assert.throws(
      () => loadConfig({ workspace: path.join(root, "unsafe"), home: path.join(root, "unsafe", ".evolve") }),
      /EVOLVE_HOME must be outside EVOLVE_WORKSPACE/,
    );
    assert.throws(
      () => loadConfig({ evaluation: { canaryMinSamples: 10, monitorWindow: 5 } }),
      /EVOLVE_EVAL_MONITOR_WINDOW/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime construction rejects unpinned images, unsafe networks, and container root", () => {
  assert.throws(
    () => createRuntime(loadConfig({ docker: { defaultImage: "node:22", allowedImages: ["node:22"] } })),
    /not sha256-pinned/,
  );
  assert.throws(
    () => createRuntime(loadConfig({ docker: { defaultImage: IMAGE, allowedImages: [IMAGE], allowedNetworks: ["host"] } })),
    /Unsafe network cannot be allowlisted/,
  );
  assert.throws(
    () => createRuntime(loadConfig({ docker: { defaultImage: IMAGE, allowedImages: [IMAGE], user: "0:0" } })),
    /non-root numeric uid:gid/,
  );
});
