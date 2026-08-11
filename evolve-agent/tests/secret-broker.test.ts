import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileSecretBroker } from "../src/secrets/secret-broker.js";

test("secret broker uses restrictive files, redacts output, and destroys the lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-secret-test-"));
  const secretRoot = path.join(root, "runtime-secrets");
  const broker = new FileSecretBroker(secretRoot, ["API_TOKEN"], 60_000, () => "very-private-value");
  try {
    const lease = await broker.materialize("run-1", ["API_TOKEN", "API_TOKEN"]);
    assert.equal(lease.mounts.length, 1);
    const mount = lease.mounts[0];
    assert.ok(mount);
    assert.equal(await readFile(mount.hostPath, "utf8"), "very-private-value");
    assert.equal((await stat(mount.hostPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(mount.hostPath))).mode & 0o777, 0o700);
    assert.equal(lease.redact("value=very-private-value"), "value=[REDACTED_SECRET:API_TOKEN]");

    await lease.release();
    assert.equal((await readdir(secretRoot)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret broker denies unapproved and empty secrets and sweeps expired leases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "evolve-secret-sweep-"));
  const values = new Map<string, string>([["GOOD_TOKEN", "abc"]]);
  const broker = new FileSecretBroker(path.join(root, "secrets"), ["GOOD_TOKEN", "EMPTY_TOKEN"], 1_000, (name) =>
    values.get(name),
  );
  try {
    await assert.rejects(broker.materialize("run", ["DENIED_TOKEN"]), /not in EVOLVE_SECRET_ALLOWLIST/);
    values.set("EMPTY_TOKEN", "");
    await assert.rejects(broker.materialize("run", ["EMPTY_TOKEN"]), /empty value/);

    const lease = await broker.materialize("run", ["GOOD_TOKEN"]);
    assert.equal((await readdir(path.join(root, "secrets"))).length, 1);
    assert.equal(await broker.sweepExpired(Date.now() + 2_000), 1);
    assert.equal((await readdir(path.join(root, "secrets"))).length, 0);
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
