import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "../core/fs.js";
import { sha256Json } from "../core/hash.js";
import { stableStringify } from "../core/stable-json.js";
import { EvolveError } from "../core/errors.js";

interface CapabilityPayload {
  version: 1;
  episodeId: string;
  toolName: string;
  argsHash: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export class CapabilityAuthority {
  private keyPromise?: Promise<Buffer>;

  public constructor(private readonly keyPath: string) {}

  private async key(): Promise<Buffer> {
    this.keyPromise ??= (async () => {
      await ensureDir(path.dirname(this.keyPath));
      try {
        const encoded = (await readFile(this.keyPath, "utf8")).trim();
        return Buffer.from(encoded, "base64url");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const generated = randomBytes(32);
        await writeFile(this.keyPath, `${generated.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
        return generated;
      }
    })();
    return this.keyPromise;
  }

  public async issue(input: {
    episodeId: string;
    toolName: string;
    args: Record<string, unknown>;
    ttlMs?: number;
  }): Promise<string> {
    const now = Date.now();
    const payload: CapabilityPayload = {
      version: 1,
      episodeId: input.episodeId,
      toolName: input.toolName,
      argsHash: sha256Json(input.args),
      issuedAt: now,
      expiresAt: now + Math.max(1, Math.min(input.ttlMs ?? 60_000, 5 * 60_000)),
      nonce: randomBytes(16).toString("hex"),
    };
    const encoded = base64url(stableStringify(payload));
    const signature = createHmac("sha256", await this.key()).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  public async verify(token: string, expected: {
    episodeId: string;
    toolName: string;
    args: Record<string, unknown>;
    now?: number;
  }): Promise<void> {
    const [encoded, signature] = token.split(".");
    if (!encoded || !signature) throw new EvolveError("CAPABILITY_INVALID", "Malformed capability token");
    const expectedSignature = createHmac("sha256", await this.key()).update(encoded).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, "base64url");
    } catch {
      throw new EvolveError("CAPABILITY_INVALID", "Malformed capability signature");
    }
    if (provided.length !== expectedSignature.length || !timingSafeEqual(provided, expectedSignature)) {
      throw new EvolveError("CAPABILITY_INVALID", "Capability signature mismatch");
    }

    let payload: CapabilityPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CapabilityPayload;
    } catch {
      throw new EvolveError("CAPABILITY_INVALID", "Malformed capability payload");
    }
    if (payload.version !== 1) throw new EvolveError("CAPABILITY_INVALID", "Unsupported capability version");
    if (payload.episodeId !== expected.episodeId || payload.toolName !== expected.toolName) {
      throw new EvolveError("CAPABILITY_SCOPE_MISMATCH", "Capability scope does not match the requested action");
    }
    if (payload.argsHash !== sha256Json(expected.args)) {
      throw new EvolveError("CAPABILITY_ARGS_MISMATCH", "Tool arguments changed after approval");
    }
    const now = expected.now ?? Date.now();
    if (payload.expiresAt < now || payload.issuedAt > now + 5_000) {
      throw new EvolveError("CAPABILITY_EXPIRED", "Capability token has expired or is not yet valid");
    }
  }
}
