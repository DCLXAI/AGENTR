import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { EvolveError } from "../core/errors.js";
import type { SkillEvaluation, SkillRecord, SkillStep } from "../core/types.js";

interface SkillFile {
  version: 1;
  records: SkillRecord[];
}

export class SkillStore {
  private readonly filePath: string;

  public constructor(home: string) {
    this.filePath = path.join(home, "skills.json");
  }

  private async load(): Promise<SkillFile> {
    const file = await readJsonFile<SkillFile>(this.filePath, { version: 1, records: [] });
    if (file.version !== 1 || !Array.isArray(file.records)) throw new EvolveError("SKILLS_CORRUPT", "Unsupported skills file");
    return file;
  }

  private async save(file: SkillFile): Promise<void> {
    await atomicWriteJson(this.filePath, file, 0o600);
  }

  public async list(): Promise<SkillRecord[]> {
    return (await this.load()).records;
  }

  public async promoted(): Promise<SkillRecord[]> {
    return (await this.list()).filter((record) => record.status === "promoted");
  }

  public async get(id: string): Promise<SkillRecord> {
    const skill = (await this.list()).find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    return skill;
  }

  public async upsertCandidate(input: {
    fingerprint: string;
    name: string;
    description: string;
    triggers: string[];
    steps: SkillStep[];
    allowedTools: string[];
    supportingEpisodes: string[];
    provenanceEvidenceIds: string[];
  }): Promise<SkillRecord> {
    const file = await this.load();
    const now = new Date().toISOString();
    let skill = file.records.find((record) => record.fingerprint === input.fingerprint && record.status !== "rolled_back");
    if (skill) {
      skill.supportingEpisodes = [...new Set([...skill.supportingEpisodes, ...input.supportingEpisodes])];
      skill.provenanceEvidenceIds = [...new Set([...skill.provenanceEvidenceIds, ...input.provenanceEvidenceIds])];
      skill.triggers = [...new Set([...skill.triggers, ...input.triggers])].slice(0, 20);
      skill.updatedAt = now;
    } else {
      skill = {
        id: `skill_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        fingerprint: input.fingerprint,
        name: input.name.slice(0, 120),
        description: input.description.slice(0, 1_000),
        triggers: [...new Set(input.triggers)].slice(0, 20),
        steps: input.steps.slice(0, 30),
        allowedTools: [...new Set(input.allowedTools)].slice(0, 30),
        supportingEpisodes: [...new Set(input.supportingEpisodes)],
        provenanceEvidenceIds: [...new Set(input.provenanceEvidenceIds)],
        status: "candidate",
        createdAt: now,
        updatedAt: now,
        evaluations: [],
        canaries: [],
      };
      file.records.push(skill);
    }
    await this.save(file);
    return skill;
  }

  public async evaluate(id: string, knownTools: Set<string>): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    if (skill.status === "promoted" || skill.status === "rolled_back") {
      throw new EvolveError("SKILL_STATE", `Cannot evaluate a ${skill.status} skill`);
    }

    const notes: string[] = [];
    const allToolsKnown = skill.allowedTools.every((tool) => knownTools.has(tool)) && skill.steps.every((step) => knownTools.has(step.toolName));
    if (!allToolsKnown) notes.push("Skill references unknown tools");
    if (skill.steps.length === 0) notes.push("Skill has no executable steps");
    if (skill.supportingEpisodes.length < 2) notes.push("At least two independent supporting episodes are required");
    if (skill.provenanceEvidenceIds.length === 0) notes.push("Skill has no provenance evidence");

    const policyPassed = allToolsKnown && skill.steps.length > 0;
    const replayPassed = skill.supportingEpisodes.length >= 2 && skill.provenanceEvidenceIds.length > 0;
    const score = [policyPassed, replayPassed, skill.supportingEpisodes.length >= 3, skill.provenanceEvidenceIds.length >= 2].filter(Boolean).length / 4;
    const evaluation: SkillEvaluation = {
      at: new Date().toISOString(),
      policyPassed,
      replayPassed,
      score,
      notes: notes.length > 0 ? notes : ["Static policy and repeated-episode replay support passed"],
    };
    skill.evaluations.push(evaluation);
    skill.status = "evaluated";
    skill.updatedAt = evaluation.at;
    await this.save(file);
    return skill;
  }

  public async recordCanary(id: string, passed: boolean, score: number, note: string): Promise<SkillRecord> {
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new EvolveError("SKILL_CANARY", "Canary score must be between 0 and 1");
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    const latest = skill.evaluations.at(-1);
    if (!latest?.policyPassed || !latest.replayPassed || latest.score < 0.5) {
      throw new EvolveError("SKILL_GATE", "Skill must pass evaluation before canary");
    }
    const at = new Date().toISOString();
    skill.canaries.push({ at, passed, score, note: note.slice(0, 2_000) });
    skill.status = "canary";
    skill.updatedAt = at;
    await this.save(file);
    return skill;
  }

  public async promote(id: string): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    const evaluation = skill.evaluations.at(-1);
    const canary = skill.canaries.at(-1);
    if (!evaluation?.policyPassed || !evaluation.replayPassed || evaluation.score < 0.8) {
      throw new EvolveError("SKILL_GATE", "Promotion requires a policy/replay evaluation score of at least 0.8");
    }
    if (!canary?.passed || canary.score < 0.8) {
      throw new EvolveError("SKILL_GATE", "Promotion requires a passing canary score of at least 0.8");
    }
    skill.status = "promoted";
    skill.updatedAt = new Date().toISOString();
    await this.save(file);
    return skill;
  }

  public async rollback(id: string, reason: string): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    skill.status = "rolled_back";
    skill.updatedAt = new Date().toISOString();
    skill.canaries.push({ at: skill.updatedAt, passed: false, score: 0, note: `Rollback: ${reason.slice(0, 1_000)}` });
    await this.save(file);
    return skill;
  }
}
