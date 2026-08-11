import path from "node:path";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { EvolveError } from "../core/errors.js";
import type { EpisodeCheckpoint } from "../core/types.js";

export class CheckpointStore {
  private readonly directory: string;

  public constructor(home: string) {
    this.directory = path.join(home, "checkpoints");
  }

  private pathFor(episodeId: string): string {
    if (!/^ep_[a-f0-9]{24}$/.test(episodeId)) throw new EvolveError("EPISODE_ID_INVALID", "Invalid episode ID");
    return path.join(this.directory, `${episodeId}.json`);
  }

  public async save(checkpoint: EpisodeCheckpoint): Promise<void> {
    checkpoint.updatedAt = new Date().toISOString();
    await atomicWriteJson(this.pathFor(checkpoint.episodeId), checkpoint, 0o600);
  }

  public async load(episodeId: string): Promise<EpisodeCheckpoint> {
    const checkpoint = await readJsonFile<EpisodeCheckpoint | null>(this.pathFor(episodeId), null);
    if (!checkpoint) throw new EvolveError("EPISODE_NOT_FOUND", `No checkpoint for ${episodeId}`);
    if (checkpoint.version !== 1 || checkpoint.episodeId !== episodeId) {
      throw new EvolveError("CHECKPOINT_CORRUPT", `Invalid checkpoint for ${episodeId}`);
    }
    checkpoint.activeSkillIds ??= [];
    return checkpoint;
  }
}
