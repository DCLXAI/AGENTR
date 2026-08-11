import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { EvolveError } from "../core/errors.js";
import type { MemoryRecord } from "../core/types.js";

interface MemoryFile {
  version: 1;
  records: MemoryRecord[];
}

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2),
  );
}

export class MemoryStore {
  private readonly filePath: string;

  public constructor(home: string) {
    this.filePath = path.join(home, "memory.json");
  }

  private async load(): Promise<MemoryFile> {
    const file = await readJsonFile<MemoryFile>(this.filePath, { version: 1, records: [] });
    if (file.version !== 1 || !Array.isArray(file.records)) throw new EvolveError("MEMORY_CORRUPT", "Unsupported memory file");
    return file;
  }

  public async add(input: {
    text: string;
    tags: string[];
    confidence: number;
    sourceEpisodeId: string;
    evidenceIds: string[];
    validEvidenceIds: Set<string>;
  }): Promise<MemoryRecord> {
    const text = input.text.trim();
    if (text.length < 4 || text.length > 2_000) throw new EvolveError("MEMORY_INVALID", "Memory text length is invalid");
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new EvolveError("MEMORY_INVALID", "Memory confidence must be between 0 and 1");
    }
    const evidenceIds = [...new Set(input.evidenceIds)];
    const invalid = evidenceIds.filter((id) => !input.validEvidenceIds.has(id));
    if (invalid.length > 0) throw new EvolveError("MEMORY_EVIDENCE_INVALID", `Invalid memory evidence: ${invalid.join(", ")}`);
    if (input.confidence >= 0.8 && evidenceIds.length === 0) {
      throw new EvolveError("MEMORY_EVIDENCE_REQUIRED", "High-confidence memory requires current-episode evidence");
    }

    const file = await this.load();
    const normalized = text.toLowerCase();
    const existing = file.records.find(
      (record) => record.sourceEpisodeId === input.sourceEpisodeId && record.text.toLowerCase() === normalized,
    );
    if (existing) return existing;

    const record: MemoryRecord = {
      id: `mem_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      text,
      tags: [...new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12),
      confidence: input.confidence,
      sourceEpisodeId: input.sourceEpisodeId,
      evidenceIds,
      createdAt: new Date().toISOString(),
    };
    file.records.push(record);
    if (file.records.length > 10_000) file.records.splice(0, file.records.length - 10_000);
    await atomicWriteJson(this.filePath, file, 0o600);
    return record;
  }

  public async search(query: string, limit = 8): Promise<MemoryRecord[]> {
    const queryTerms = terms(query);
    if (queryTerms.size === 0) return [];
    const records = (await this.load()).records;
    return records
      .map((record) => {
        const recordTerms = terms(`${record.text} ${record.tags.join(" ")}`);
        let overlap = 0;
        for (const term of queryTerms) if (recordTerms.has(term)) overlap += 1;
        const recencyDays = Math.max(0, (Date.now() - Date.parse(record.createdAt)) / 86_400_000);
        const recency = 1 / (1 + recencyDays / 30);
        return { record, score: overlap * 2 + record.confidence + recency * 0.25 };
      })
      .filter((entry) => entry.score > 0.5)
      .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt))
      .slice(0, Math.max(0, Math.min(limit, 50)))
      .map((entry) => entry.record);
  }

  public async list(): Promise<MemoryRecord[]> {
    return (await this.load()).records;
  }
}
