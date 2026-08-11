import path from "node:path";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { sha256Json } from "../core/hash.js";
import type { EpisodeCheckpoint } from "../core/types.js";
import type { SkillStore } from "../skills/skill-store.js";

interface PatternRecord {
  fingerprint: string;
  toolSequence: string[];
  episodes: string[];
  evidenceIds: string[];
  triggerTerms: string[];
}

interface PatternFile {
  version: 1;
  records: PatternRecord[];
}

function triggerTerms(goal: string): string[] {
  return [...new Set(goal.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 4))].slice(0, 12);
}

export class LearningEngine {
  private readonly filePath: string;

  public constructor(home: string, private readonly skills: SkillStore) {
    this.filePath = path.join(home, "patterns.json");
  }

  public async observeCommitted(checkpoint: EpisodeCheckpoint): Promise<void> {
    if (checkpoint.status !== "committed" || checkpoint.toolSequence.length === 0) return;
    const sequence = checkpoint.toolSequence.slice(0, 30);
    const fingerprint = sha256Json({ version: 1, sequence });
    const file = await readJsonFile<PatternFile>(this.filePath, { version: 1, records: [] });
    let pattern = file.records.find((record) => record.fingerprint === fingerprint);
    if (!pattern) {
      pattern = {
        fingerprint,
        toolSequence: sequence,
        episodes: [],
        evidenceIds: [],
        triggerTerms: [],
      };
      file.records.push(pattern);
    }
    pattern.episodes = [...new Set([...pattern.episodes, checkpoint.episodeId])];
    pattern.evidenceIds = [...new Set([...pattern.evidenceIds, ...checkpoint.evidenceIds])].slice(-100);
    pattern.triggerTerms = [...new Set([...pattern.triggerTerms, ...triggerTerms(checkpoint.task.goal)])].slice(0, 20);
    await atomicWriteJson(this.filePath, file, 0o600);

    if (pattern.episodes.length >= 2) {
      await this.skills.upsertCandidate({
        fingerprint,
        name: `Learned flow: ${sequence.join(" → ")}`.slice(0, 120),
        description: `Candidate procedure derived from ${pattern.episodes.length} committed episodes. It remains inactive until evaluation and canary gates pass.`,
        triggers: pattern.triggerTerms,
        steps: sequence.map((toolName, index) => ({ toolName, purpose: `Step ${index + 1} in the observed successful flow` })),
        allowedTools: [...new Set(sequence)],
        supportingEpisodes: pattern.episodes,
        provenanceEvidenceIds: pattern.evidenceIds,
      });
    }
  }
}
