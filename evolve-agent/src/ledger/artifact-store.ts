import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists } from "../core/fs.js";
import { sha256Bytes, sha256Json } from "../core/hash.js";
import { stableStringify } from "../core/stable-json.js";
import type { EvidenceRecord, JsonValue } from "../core/types.js";

interface ArtifactEnvelope {
  version: 1;
  mediaType: "application/json";
  data: JsonValue;
}

export class ArtifactStore {
  private readonly artifactsDir: string;
  private readonly evidenceDir: string;

  public constructor(home: string) {
    this.artifactsDir = path.join(home, "artifacts");
    this.evidenceDir = path.join(home, "evidence");
  }

  public async put(input: {
    episodeId: string;
    toolName: string;
    args: Record<string, unknown>;
    data: JsonValue;
    summary: string;
    success: boolean;
  }): Promise<EvidenceRecord> {
    await ensureDir(this.artifactsDir);
    await ensureDir(this.evidenceDir);
    const envelope: ArtifactEnvelope = { version: 1, mediaType: "application/json", data: input.data };
    const serialized = `${stableStringify(envelope)}\n`;
    const artifactHash = sha256Bytes(serialized);
    const artifactPath = path.join(this.artifactsDir, `${artifactHash}.json`);
    if (!(await pathExists(artifactPath))) await writeFile(artifactPath, serialized, { encoding: "utf8", flag: "wx" });

    const createdAt = new Date().toISOString();
    const argsHash = sha256Json(input.args);
    const id = `ev_${sha256Json({
      episodeId: input.episodeId,
      toolName: input.toolName,
      argsHash,
      artifactHash,
      createdAt,
    }).slice(0, 24)}`;
    const evidence: EvidenceRecord = {
      id,
      episodeId: input.episodeId,
      toolName: input.toolName,
      argsHash,
      artifactHash,
      summary: input.summary.slice(0, 500),
      success: input.success,
      createdAt,
    };
    await writeFile(path.join(this.evidenceDir, `${id}.json`), `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return evidence;
  }

  public async getEvidence(id: string): Promise<EvidenceRecord | undefined> {
    if (!/^ev_[a-f0-9]{24}$/.test(id)) return undefined;
    try {
      return JSON.parse(await readFile(path.join(this.evidenceDir, `${id}.json`), "utf8")) as EvidenceRecord;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async readArtifact(artifactHash: string): Promise<JsonValue | undefined> {
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) return undefined;
    try {
      const envelope = JSON.parse(await readFile(path.join(this.artifactsDir, `${artifactHash}.json`), "utf8")) as ArtifactEnvelope;
      return envelope.data;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async validateEvidenceIds(episodeId: string, ids: string[]): Promise<{ valid: boolean; invalid: string[] }> {
    const invalid: string[] = [];
    for (const id of new Set(ids)) {
      const evidence = await this.getEvidence(id);
      if (!evidence || evidence.episodeId !== episodeId) invalid.push(id);
    }
    return { valid: invalid.length === 0, invalid };
  }

  public async summaries(episodeId: string, ids: string[]): Promise<Array<{ id: string; summary: string; success: boolean }>> {
    const output: Array<{ id: string; summary: string; success: boolean }> = [];
    for (const id of ids) {
      const evidence = await this.getEvidence(id);
      if (evidence?.episodeId === episodeId) output.push({ id, summary: evidence.summary, success: evidence.success });
    }
    return output;
  }
}
