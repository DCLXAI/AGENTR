import assert from "node:assert/strict";
import { hostname } from "node:os";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EpisodeLeaseManager, type EpisodeLeaseRecord } from "../src/runtime/lease-manager.js";

const EPISODE = "ep_aaaaaaaaaaaaaaaaaaaaaaaa";

async function writeStale(home: string, record: EpisodeLeaseRecord): Promise<void> {
  const directory = path.join(home, "leases");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${EPISODE}.lock`);
  await writeFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  const old = new Date(Date.now() - 10_000);
  await utimes(target, old, old);
}

test("episode lease rejects concurrent ownership and releases cleanly", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "evolve-lease-test-"));
  const first = new EpisodeLeaseManager(home, { ttlMs: 2_000, heartbeatMs: 200, ownerId: "owner-a" });
  const second = new EpisodeLeaseManager(home, { ttlMs: 2_000, heartbeatMs: 200, ownerId: "owner-b" });
  try {
    const lease = await first.acquire(EPISODE);
    await assert.rejects(second.acquire(EPISODE), /is leased by owner-a/);
    await lease.release();
    const next = await second.acquire(EPISODE);
    assert.equal(next.ownerId, "owner-b");
    await next.release();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stale lease is recovered only when the recorded local process is gone", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "evolve-lease-stale-"));
  const manager = new EpisodeLeaseManager(home, {
    ttlMs: 1_000,
    heartbeatMs: 100,
    ownerId: "recovery-owner",
    hostname: hostname(),
  });
  try {
    await writeStale(home, {
      version: 1,
      episodeId: EPISODE,
      ownerId: "dead-owner",
      pid: 999_999_999,
      hostname: hostname(),
      acquiredAt: new Date(Date.now() - 20_000).toISOString(),
    });
    const recovered = await manager.acquire(EPISODE);
    assert.equal(recovered.recovered?.ownerId, "dead-owner");
    await recovered.release();

    await writeStale(home, {
      version: 1,
      episodeId: EPISODE,
      ownerId: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date(Date.now() - 20_000).toISOString(),
    });
    await assert.rejects(manager.acquire(EPISODE), /owner process .* is still alive/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
