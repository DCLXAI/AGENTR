import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson, readJsonFile } from "../core/fs.js";
import { EvolveError } from "../core/errors.js";
import type { SkillRecord, SkillStep } from "../core/types.js";
import type { PromotionAuthorization } from "../evaluation/types.js";

export interface SkillPromotionVerifier {
  verifyPromotion(skill: SkillRecord, authorization: PromotionAuthorization): Promise<void>;
}

interface SkillFileV1 {
  version: 1;
  records: Array<SkillRecord & Partial<Pick<SkillRecord, "evaluationReportIds" | "canaryReportIds">>>;
}

interface SkillFile {
  version: 2;
  records: SkillRecord[];
}

function migrate(file: SkillFile | SkillFileV1): SkillFile {
  if (file.version === 2) return file;
  return {
    version: 2,
    records: file.records.map((record) => ({
      ...record,
      evaluationReportIds: [...(record.evaluationReportIds ?? [])],
      canaryReportIds: [...(record.canaryReportIds ?? [])],
    })),
  };
}

export class SkillStore {
  private readonly filePath: string;

  public constructor(home: string, private readonly promotionVerifier?: SkillPromotionVerifier) {
    this.filePath = path.join(home, "skills.json");
  }

  private async load(): Promise<SkillFile> {
    const raw = await readJsonFile<SkillFile | SkillFileV1>(this.filePath, { version: 2, records: [] });
    if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.records)) {
      throw new EvolveError("SKILLS_CORRUPT", "Unsupported skills file");
    }
    const file = migrate(raw);
    if (raw.version === 1) await this.save(file);
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
      // Once evaluation starts, freeze the training provenance. New Episodes become independent holdout material.
      if (skill.status === "candidate") {
        skill.supportingEpisodes = [...new Set([...skill.supportingEpisodes, ...input.supportingEpisodes])];
        skill.provenanceEvidenceIds = [...new Set([...skill.provenanceEvidenceIds, ...input.provenanceEvidenceIds])];
      }
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
        evaluationReportIds: [],
        canaryReportIds: [],
      };
      file.records.push(skill);
    }
    await this.save(file);
    return skill;
  }

  public async attachEvaluationReport(id: string, reportId: string, passed: boolean): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    if (skill.status === "promoted" || skill.status === "rolled_back") {
      throw new EvolveError("SKILL_STATE", `Cannot attach an offline evaluation to a ${skill.status} Skill`);
    }
    skill.evaluationReportIds = [...new Set([...skill.evaluationReportIds, reportId])];
    skill.status = passed ? "evaluated" : "quarantined";
    skill.updatedAt = new Date().toISOString();
    await this.save(file);
    return skill;
  }

  public async attachCanaryReport(id: string, reportId: string, passed: boolean): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    if (skill.status === "promoted" || skill.status === "rolled_back") {
      throw new EvolveError("SKILL_STATE", `Cannot attach a canary evaluation to a ${skill.status} Skill`);
    }
    if (skill.evaluationReportIds.length === 0) {
      throw new EvolveError("SKILL_GATE", "Canary requires a signed offline evaluation report");
    }
    skill.canaryReportIds = [...new Set([...skill.canaryReportIds, reportId])];
    skill.status = passed ? "canary" : "quarantined";
    skill.updatedAt = new Date().toISOString();
    await this.save(file);
    return skill;
  }

  public async promote(id: string, authorization: PromotionAuthorization): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    if (skill.status !== "canary") throw new EvolveError("SKILL_GATE", "Promotion requires a passing canary state");
    if (!skill.evaluationReportIds.includes(authorization.offlineReportId)) {
      throw new EvolveError("SKILL_GATE", "Offline report is not attached to this Skill");
    }
    if (!skill.canaryReportIds.includes(authorization.canaryReportId)) {
      throw new EvolveError("SKILL_GATE", "Canary report is not attached to this Skill");
    }
    if (!this.promotionVerifier) {
      throw new EvolveError("SKILL_AUTHORITY", "A signed-report promotion verifier is required");
    }
    await this.promotionVerifier.verifyPromotion(skill, authorization);
    const at = new Date().toISOString();
    skill.status = "promoted";
    skill.promotion = { at, ...authorization };
    delete skill.rollback;
    skill.updatedAt = at;
    await this.save(file);
    return skill;
  }

  public async quarantine(id: string, reason: string): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    if (skill.status === "promoted") throw new EvolveError("SKILL_STATE", "Use rollback for a promoted Skill");
    skill.status = "quarantined";
    skill.updatedAt = new Date().toISOString();
    skill.canaries.push({ at: skill.updatedAt, passed: false, score: 0, note: `Quarantine: ${reason.slice(0, 1_000)}` });
    await this.save(file);
    return skill;
  }

  public async rollback(
    id: string,
    reason: string,
    options: { automatic?: boolean; reportId?: string } = {},
  ): Promise<SkillRecord> {
    const file = await this.load();
    const skill = file.records.find((record) => record.id === id);
    if (!skill) throw new EvolveError("SKILL_NOT_FOUND", `Unknown skill: ${id}`);
    const at = new Date().toISOString();
    skill.status = "rolled_back";
    skill.updatedAt = at;
    skill.rollback = {
      at,
      reason: reason.slice(0, 2_000),
      automatic: options.automatic ?? false,
      ...(options.reportId ? { reportId: options.reportId } : {}),
    };
    skill.canaries.push({ at, passed: false, score: 0, note: `Rollback: ${reason.slice(0, 1_000)}` });
    await this.save(file);
    return skill;
  }
}
