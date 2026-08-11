import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { EvolveError } from "../core/errors.js";
import { ensureDir } from "../core/fs.js";

export interface EpisodeLeaseRecord {
  version: 1;
  episodeId: string;
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface EpisodeLease {
  episodeId: string;
  ownerId: string;
  recovered?: EpisodeLeaseRecord;
  release(): Promise<void>;
}

export interface EpisodeLeaseOptions {
  ttlMs: number;
  heartbeatMs: number;
  ownerId?: string;
  hostname?: string;
}

function validateEpisodeId(episodeId: string): void {
  if (!/^ep_[a-f0-9]{24}$/.test(episodeId)) throw new EvolveError("EPISODE_ID_INVALID", "Invalid episode ID");
}

async function readRecord(target: string): Promise<EpisodeLeaseRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as Partial<EpisodeLeaseRecord>;
    if (
      value.version !== 1 ||
      typeof value.ownerId !== "string" ||
      typeof value.episodeId !== "string" ||
      typeof value.pid !== "number" ||
      typeof value.hostname !== "string" ||
      typeof value.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return value as EpisodeLeaseRecord;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export class EpisodeLeaseManager {
  private readonly directory: string;
  private readonly ownerId: string;
  private readonly host: string;

  public constructor(home: string, private readonly options: EpisodeLeaseOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs < 1_000) throw new Error("Lease TTL must be at least 1000 ms");
    if (!Number.isFinite(options.heartbeatMs) || options.heartbeatMs < 100 || options.heartbeatMs * 2 >= options.ttlMs) {
      throw new Error("Lease heartbeat must be at least 100 ms and less than half of the TTL");
    }
    this.directory = path.join(home, "leases");
    this.ownerId = options.ownerId ?? `${process.pid}-${randomUUID()}`;
    this.host = options.hostname ?? hostname();
  }

  private pathFor(episodeId: string): string {
    validateEpisodeId(episodeId);
    return path.join(this.directory, `${episodeId}.lock`);
  }

  public async acquire(episodeId: string): Promise<EpisodeLease> {
    const target = this.pathFor(episodeId);
    await ensureDir(this.directory);
    let recovered: EpisodeLeaseRecord | undefined;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      let handle: FileHandle;
      try {
        handle = await open(target, "wx", 0o600);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let currentStats;
        try {
          currentStats = await stat(target);
        } catch (statError: unknown) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        const ageMs = Date.now() - currentStats.mtimeMs;
        const current = await readRecord(target);
        if (ageMs < this.options.ttlMs) {
          throw new EvolveError(
            "EPISODE_LOCKED",
            `Episode ${episodeId} is leased${current ? ` by ${current.ownerId}` : ""}; retry after the lease TTL`,
          );
        }
        if (current?.hostname === this.host && processIsAlive(current.pid)) {
          throw new EvolveError(
            "EPISODE_LOCK_HEARTBEAT_STALE",
            `Episode ${episodeId} has a stale heartbeat but its local owner process ${current.pid} is still alive`,
          );
        }

        recovered = current;
        const quarantine = path.join(
          this.directory,
          `${episodeId}.stale.${Date.now()}.${randomUUID().replaceAll("-", "")}`,
        );
        try {
          await rename(target, quarantine);
          await rm(quarantine, { force: true });
        } catch (renameError: unknown) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameError;
        }
        continue;
      }

      const record: EpisodeLeaseRecord = {
        version: 1,
        episodeId,
        ownerId: this.ownerId,
        pid: process.pid,
        hostname: this.host,
        acquiredAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } catch (error: unknown) {
        await handle.close().catch(() => undefined);
        await unlink(target).catch(() => undefined);
        throw error;
      }

      let released = false;
      const heartbeat = setInterval(() => {
        const now = new Date();
        void handle.utimes(now, now).catch(() => undefined);
      }, this.options.heartbeatMs);
      heartbeat.unref();

      return {
        episodeId,
        ownerId: this.ownerId,
        ...(recovered !== undefined ? { recovered } : {}),
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await handle.close().catch(() => undefined);
          const current = await readRecord(target);
          if (current?.ownerId !== this.ownerId) return;
          await unlink(target).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          });
        },
      };
    }

    throw new EvolveError("LEASE_ACQUIRE_FAILED", `Could not acquire a stable lease for ${episodeId}`);
  }

  public async withLease<T>(episodeId: string, callback: (lease: EpisodeLease) => Promise<T>): Promise<T> {
    const lease = await this.acquire(episodeId);
    try {
      return await callback(lease);
    } finally {
      await lease.release();
    }
  }
}
