import { readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, ensureDir, readJsonFile } from "../core/fs.js";
import { EvolveError } from "../core/errors.js";
import { sha256Json } from "../core/hash.js";
import type { SkillRecord } from "../core/types.js";
import type { PromotionAuthorization } from "./types.js";
import type { EvaluationReportPayload, SignedEvaluationReport } from "./types.js";
import type { ProvenanceSigner } from "./provenance-signer.js";

const REPORT_ID = /^report_[a-f0-9]{24}$/;

export class EvaluationReportStore {
  private readonly directory: string;

  public constructor(home: string, private readonly signer: ProvenanceSigner) {
    this.directory = path.join(home, "evaluations", "reports");
  }

  private pathFor(id: string): string {
    if (!REPORT_ID.test(id)) throw new EvolveError("REPORT_ID", `Invalid report ID: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }

  public async create(payload: EvaluationReportPayload): Promise<SignedEvaluationReport> {
    const report = await this.signer.sign(payload);
    await atomicWriteJson(this.pathFor(report.id), report, 0o600);
    return report;
  }

  public async get(id: string): Promise<SignedEvaluationReport> {
    const report = await readJsonFile<SignedEvaluationReport | null>(this.pathFor(id), null);
    if (!report) throw new EvolveError("REPORT_NOT_FOUND", `Unknown evaluation report: ${id}`);
    return report;
  }

  public async verify(idOrReport: string | SignedEvaluationReport): Promise<boolean> {
    const report = typeof idOrReport === "string" ? await this.get(idOrReport) : idOrReport;
    return this.signer.verify(report);
  }

  public async requireVerified(id: string): Promise<SignedEvaluationReport> {
    const report = await this.get(id);
    if (!(await this.verify(report))) throw new EvolveError("REPORT_SIGNATURE", `Evaluation report signature failed: ${id}`);
    return report;
  }

  public async verifyPromotion(skill: SkillRecord, authorization: PromotionAuthorization): Promise<void> {
    const offline = await this.requireVerified(authorization.offlineReportId);
    const canary = await this.requireVerified(authorization.canaryReportId);
    if (offline.payload.kind !== "offline" || canary.payload.kind !== "canary") {
      throw new EvolveError("SKILL_GATE", "Promotion authorization report kinds are invalid");
    }
    for (const report of [offline, canary]) {
      if (report.payload.skillId !== skill.id || report.payload.skillFingerprint !== skill.fingerprint) {
        throw new EvolveError("SKILL_GATE", "Promotion report provenance does not match this Skill");
      }
      if (!report.payload.decision.passed) {
        throw new EvolveError("SKILL_GATE", `${report.payload.kind} evaluation did not pass`);
      }
      if (report.keyFingerprint !== authorization.keyFingerprint) {
        throw new EvolveError("SKILL_GATE", "Promotion authority fingerprint does not match the signed reports");
      }
    }
    const policyHash = sha256Json({ offline: offline.payload.policy, canary: canary.payload.policy });
    if (policyHash !== authorization.policyHash) {
      throw new EvolveError("SKILL_GATE", "Promotion policy hash does not match the signed reports");
    }
  }

  public async list(): Promise<SignedEvaluationReport[]> {
    await ensureDir(this.directory);
    const files = (await readdir(this.directory)).filter((file) => /^report_[a-f0-9]{24}\.json$/.test(file)).sort();
    const reports: SignedEvaluationReport[] = [];
    for (const file of files) reports.push(await this.get(file.slice(0, -5)));
    return reports;
  }
}
