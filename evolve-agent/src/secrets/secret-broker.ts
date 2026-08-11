import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvolveError } from "../core/errors.js";
import { ensureDir } from "../core/fs.js";

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRET_BYTES = 64 * 1024;

export interface SecretMount {
  name: string;
  hostPath: string;
  containerPath: string;
}

export interface SecretLease {
  mounts: SecretMount[];
  redact(text: string): string;
  release(): Promise<void>;
}

export interface SecretBroker {
  materialize(runId: string, names: string[]): Promise<SecretLease>;
  sweepExpired(now?: number): Promise<number>;
  allowedNames(): string[];
}

export type SecretSource = (name: string) => string | undefined;

interface SecretLeaseMetadata {
  version: 1;
  createdAt: string;
  expiresAt: string;
}

function redactWith(values: Array<{ name: string; value: string }>, text: string): string {
  let output = text;
  for (const secret of [...values].sort((left, right) => right.value.length - left.value.length)) {
    output = output.replaceAll(secret.value, `[REDACTED_SECRET:${secret.name}]`);
  }
  return output;
}

export class FileSecretBroker implements SecretBroker {
  private readonly allowed: Set<string>;

  public constructor(
    private readonly root: string,
    allowedNames: Iterable<string>,
    private readonly ttlMs: number,
    private readonly source: SecretSource = (name) => process.env[name],
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) throw new Error("Secret TTL must be at least 1000 ms");
    this.allowed = new Set([...allowedNames].map((value) => value.trim()).filter(Boolean));
  }

  public allowedNames(): string[] {
    return [...this.allowed].sort();
  }

  public async materialize(runId: string, names: string[]): Promise<SecretLease> {
    const unique = [...new Set(names)].sort();
    if (unique.length === 0) {
      return { mounts: [], redact: (text) => text, release: async () => undefined };
    }
    for (const name of unique) {
      if (!SECRET_NAME.test(name)) throw new EvolveError("SECRET_NAME_INVALID", `Invalid secret name: ${name}`);
      if (!this.allowed.has(name)) throw new EvolveError("SECRET_NOT_ALLOWED", `${name} is not in EVOLVE_SECRET_ALLOWLIST`);
    }

    await this.sweepExpired();
    await ensureDir(this.root);
    const safeRunId = runId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
    const directory = path.join(this.root, `${safeRunId}-${randomUUID().replaceAll("-", "")}`);
    await mkdir(directory, { mode: 0o700 });

    let released = false;
    try {
      const mounts: SecretMount[] = [];
      const values: Array<{ name: string; value: string }> = [];
      for (const name of unique) {
        const value = this.source(name);
        if (value === undefined) throw new EvolveError("SECRET_UNAVAILABLE", `${name} is allowlisted but not configured`);
        if (value.length === 0) throw new EvolveError("SECRET_EMPTY", `${name} is configured with an empty value`);
        if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
          throw new EvolveError("SECRET_TOO_LARGE", `${name} exceeds the ${MAX_SECRET_BYTES}-byte secret limit`);
        }
        const hostPath = path.join(directory, name);
        await writeFile(hostPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
        mounts.push({ name, hostPath, containerPath: `/run/secrets/${name}` });
        values.push({ name, value });
      }
      const metadata: SecretLeaseMetadata = {
        version: 1,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      };
      await writeFile(path.join(directory, ".lease.json"), `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      return {
        mounts,
        redact: (text) => redactWith(values, text),
        release: async () => {
          if (released) return;
          released = true;
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error: unknown) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private async expired(target: string, now: number): Promise<boolean> {
    try {
      const metadata = JSON.parse(await readFile(path.join(target, ".lease.json"), "utf8")) as Partial<SecretLeaseMetadata>;
      if (metadata.version === 1 && typeof metadata.expiresAt === "string") {
        const expiresAt = Date.parse(metadata.expiresAt);
        if (Number.isFinite(expiresAt)) return expiresAt <= now;
      }
    } catch {
      // Fall back to directory age for interrupted or malformed materialization.
    }
    const stats = await stat(target);
    return stats.mtimeMs + this.ttlMs <= now;
  }

  public async sweepExpired(now = Date.now()): Promise<number> {
    await ensureDir(this.root);
    const entries = await readdir(this.root, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(this.root, entry.name);
      try {
        if (!(await this.expired(target, now))) continue;
        await rm(target, { recursive: true, force: true });
        removed += 1;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return removed;
  }
}
