import { generateKeyPairSync, sign, verify } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, pathExists } from "../core/fs.js";
import { sha256Bytes, sha256Json } from "../core/hash.js";
import { stableStringify } from "../core/stable-json.js";
import type { EvaluationReportPayload, SignedEvaluationReport } from "./types.js";

export class ProvenanceSigner {
  private readonly privatePath: string;
  private readonly publicPath: string;
  private initialization?: Promise<void>;

  public constructor(home: string) {
    const directory = path.join(home, "evaluations", "authority");
    this.privatePath = path.join(directory, "ed25519-private.pem");
    this.publicPath = path.join(directory, "ed25519-public.pem");
  }

  private async ensureKeys(): Promise<void> {
    this.initialization ??= (async () => {
      const privateExists = await pathExists(this.privatePath);
      const publicExists = await pathExists(this.publicPath);
      if (privateExists !== publicExists) throw new Error("Evaluation signing keypair is incomplete");
      if (!privateExists) {
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        await atomicWriteFile(this.privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
        await atomicWriteFile(this.publicPath, publicKey.export({ type: "spki", format: "pem" }), 0o644);
      }
      await chmod(this.privatePath, 0o600);
    })();
    await this.initialization;
  }

  public async publicKeyFingerprint(): Promise<string> {
    await this.ensureKeys();
    return sha256Bytes(await readFile(this.publicPath)).slice(0, 32);
  }

  public async sign(payload: EvaluationReportPayload): Promise<SignedEvaluationReport> {
    await this.ensureKeys();
    const payloadHash = sha256Json(payload);
    const privateKey = await readFile(this.privatePath, "utf8");
    const signature = sign(null, Buffer.from(stableStringify(payload), "utf8"), privateKey).toString("base64url");
    return {
      id: `report_${payloadHash.slice(0, 24)}`,
      payload,
      payloadHash,
      signature,
      keyFingerprint: await this.publicKeyFingerprint(),
    };
  }

  public async verify(report: SignedEvaluationReport): Promise<boolean> {
    await this.ensureKeys();
    if (report.id !== `report_${report.payloadHash.slice(0, 24)}`) return false;
    if (sha256Json(report.payload) !== report.payloadHash) return false;
    if (report.keyFingerprint !== (await this.publicKeyFingerprint())) return false;
    const publicKey = await readFile(this.publicPath, "utf8");
    try {
      return verify(
        null,
        Buffer.from(stableStringify(report.payload), "utf8"),
        publicKey,
        Buffer.from(report.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }
}
