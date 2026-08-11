import path from "node:path";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import type { ProductionOutcome, ShadowObservation } from "./types.js";

interface ShadowFile {
  version: 1;
  observations: ShadowObservation[];
  production: ProductionOutcome[];
}

export class ShadowStore {
  private readonly filePath: string;

  public constructor(home: string, private readonly maxWindow: number) {
    this.filePath = path.join(home, "evaluations", "shadow.json");
  }

  private async load(): Promise<ShadowFile> {
    const file = await readJsonFile<ShadowFile>(this.filePath, { version: 1, observations: [], production: [] });
    if (file.version !== 1 || !Array.isArray(file.observations) || !Array.isArray(file.production)) {
      throw new Error("Unsupported shadow evaluation store");
    }
    return file;
  }

  private async save(file: ShadowFile): Promise<void> {
    await atomicWriteJson(this.filePath, file, 0o600);
  }

  public async addObservation(observation: ShadowObservation): Promise<ShadowObservation> {
    const file = await this.load();
    const existing = file.observations.find(
      (entry) => entry.skillId === observation.skillId && entry.episodeId === observation.episodeId && entry.mode === observation.mode,
    );
    if (existing) return existing;
    file.observations.push(observation);
    file.observations = this.trim(file.observations, (entry) => entry.skillId);
    await this.save(file);
    return observation;
  }

  public async observations(skillId: string, mode?: ShadowObservation["mode"]): Promise<ShadowObservation[]> {
    return (await this.load()).observations.filter(
      (entry) => entry.skillId === skillId && (mode === undefined || entry.mode === mode),
    );
  }

  public async addProduction(outcome: ProductionOutcome): Promise<ProductionOutcome> {
    const file = await this.load();
    const existing = file.production.find((entry) => entry.skillId === outcome.skillId && entry.episodeId === outcome.episodeId);
    if (existing) return existing;
    file.production.push(outcome);
    file.production = this.trim(file.production, (entry) => entry.skillId);
    await this.save(file);
    return outcome;
  }

  public async production(skillId: string): Promise<ProductionOutcome[]> {
    return (await this.load()).production.filter((entry) => entry.skillId === skillId);
  }

  private trim<T>(records: T[], key: (record: T) => string): T[] {
    const grouped = new Map<string, T[]>();
    for (const record of records) grouped.set(key(record), [...(grouped.get(key(record)) ?? []), record]);
    return [...grouped.values()].flatMap((entries) => entries.slice(-this.maxWindow));
  }
}
