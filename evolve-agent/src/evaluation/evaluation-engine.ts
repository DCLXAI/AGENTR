import { randomUUID } from "node:crypto";
import { EvolveError } from "../core/errors.js";
import { sha256Json } from "../core/hash.js";
import type { EpisodeCheckpoint, SkillRecord } from "../core/types.js";
import type { AgentProvider } from "../providers/provider.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { ToolRegistry } from "../tools/registry.js";
import { aggregateRuns, compareRuns, defaultEvaluationPolicy } from "./metrics.js";
import type { FixtureStore } from "./fixture-store.js";
import { ReplayHarness } from "./replay-harness.js";
import type { EvaluationReportStore } from "./report-store.js";
import type { ShadowStore } from "./shadow-store.js";
import type {
  EvaluationAggregate,
  EvaluationComparison,
  EvaluationDecision,
  EvaluationPolicy,
  EvaluationReportPayload,
  EvaluationSelection,
  FixtureSplit,
  ProductionOutcome,
  ReplayFixture,
  ReplayRunResult,
  ShadowObservation,
  SignedEvaluationReport,
} from "./types.js";

export interface EvaluationEngineOptions {
  policy: EvaluationPolicy;
  canaryMinSamples: number;
  monitorMinSamples: number;
  monitorMaxSuccessDrop: number;
  monitorMaxScoreDrop: number;
  monitorMaxTokenRatio: number;
}

function matchesSkill(skill: SkillRecord, fixture: ReplayFixture): boolean {
  const goal = fixture.task.goal.toLowerCase();
  const triggerMatch = skill.triggers.some((trigger) => trigger.length >= 3 && goal.includes(trigger.toLowerCase()));
  if (triggerMatch) return true;
  const expected = skill.steps.map((step) => step.toolName);
  const observed = fixture.trace.map((step) => step.toolName);
  return expected.length > 0 && expected.length === observed.length && expected.every((tool, index) => observed[index] === tool);
}

function providerName(provider: AgentProvider): string {
  return provider.constructor?.name || "AgentProvider";
}

function monitorComparison(
  expected: EvaluationAggregate,
  observed: EvaluationAggregate,
): EvaluationComparison {
  const ratio = (candidate: number, baseline: number): number =>
    baseline === 0 ? (candidate === 0 ? 1 : Number.POSITIVE_INFINITY) : candidate / baseline;
  return {
    pairedSamples: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    newFailures: Math.max(0, expected.successes - observed.successes),
    successDelta: observed.successRate - expected.successRate,
    verifierScoreDelta: observed.meanVerifierScore - expected.meanVerifierScore,
    totalTokenRatio: ratio(observed.meanTotalTokens, expected.meanTotalTokens),
    toolCallRatio: ratio(observed.meanToolCalls, expected.meanToolCalls),
    durationRatio: ratio(observed.meanDurationMs, expected.meanDurationMs),
    confidence: {
      successDeltaLower: observed.successRate - expected.successRate,
      successDeltaUpper: observed.successRate - expected.successRate,
      verifierScoreDeltaLower: observed.meanVerifierScore - expected.meanVerifierScore,
      verifierScoreDeltaUpper: observed.meanVerifierScore - expected.meanVerifierScore,
    },
  };
}

export class EvaluationEngine {
  private readonly replay: ReplayHarness;

  public constructor(
    private readonly fixtures: FixtureStore,
    private readonly reports: EvaluationReportStore,
    private readonly shadow: ShadowStore,
    private readonly skills: SkillStore,
    provider: AgentProvider,
    tools: ToolRegistry,
    private readonly options: EvaluationEngineOptions,
  ) {
    this.replay = new ReplayHarness(provider, tools.modelDescriptions());
    this.provider = provider;
  }

  private readonly provider: AgentProvider;

  public async evaluateSkill(skillId: string, selection: EvaluationSelection = {}): Promise<SignedEvaluationReport> {
    const skill = await this.skills.get(skillId);
    if (skill.status === "promoted" || skill.status === "rolled_back") {
      throw new EvolveError("SKILL_STATE", `Cannot run offline evaluation for a ${skill.status} Skill`);
    }
    const policy = defaultEvaluationPolicy({
      ...this.options.policy,
      ...(selection.repeats !== undefined ? { repeats: selection.repeats } : {}),
      requireImprovement: true,
    });
    const fixtures = await this.selectFixtures(skill, selection, policy.minFixtures);
    const promoted = (await this.skills.promoted()).filter(
      (record) => record.id !== skill.id && fixtures.some((fixture) => matchesSkill(record, fixture)),
    );
    const baselineRuns: ReplayRunResult[] = [];
    const candidateRuns: ReplayRunResult[] = [];

    for (let repeat = 0; repeat < policy.repeats; repeat += 1) {
      for (let index = 0; index < fixtures.length; index += 1) {
        const fixture = fixtures[index] as ReplayFixture;
        const baselineInput = { fixture, arm: "baseline" as const, repeat, skills: promoted };
        const candidateInput = { fixture, arm: "candidate" as const, repeat, skills: [...promoted, skill] };
        if ((index + repeat) % 2 === 0) {
          baselineRuns.push(await this.replay.run(baselineInput));
          candidateRuns.push(await this.replay.run(candidateInput));
        } else {
          candidateRuns.push(await this.replay.run(candidateInput));
          baselineRuns.push(await this.replay.run(baselineInput));
        }
      }
    }

    const metrics = compareRuns(baselineRuns, candidateRuns, policy);
    const report = await this.reports.create(
      this.payload("offline", skill, fixtures, policy, baselineRuns, candidateRuns, metrics, [
        "Supporting Episodes were excluded to prevent train/evaluation leakage.",
        "Baseline and candidate used the same fixtures, tools, verifier, and budgets.",
      ]),
    );
    await this.skills.attachEvaluationReport(skill.id, report.id, report.payload.decision.passed);
    return report;
  }

  public async shadowEpisode(
    skillId: string,
    episodeId: string,
    requestedMode?: ShadowObservation["mode"],
  ): Promise<ShadowObservation> {
    const skill = await this.skills.get(skillId);
    if (skill.supportingEpisodes.includes(episodeId)) {
      throw new EvolveError("EVAL_LEAKAGE", "A Skill cannot shadow-evaluate one of its supporting Episodes");
    }
    const fixture = (await this.fixtures.forEpisode(episodeId)) ?? (await this.fixtures.capture(episodeId));
    if (!matchesSkill(skill, fixture)) throw new EvolveError("EVAL_FIXTURE", "Episode does not match the Skill triggers or trace");
    const active = fixture.baseline.activeSkillIds.includes(skill.id);
    const mode = requestedMode ?? (skill.status === "promoted" && active ? "production-candidate" : "production-baseline");
    if (mode === "production-baseline" && active) {
      throw new EvolveError("EVAL_ARM", "Production baseline Episode already used the candidate Skill");
    }
    if (mode === "production-candidate" && !active) {
      throw new EvolveError("EVAL_ARM", "Production candidate Episode did not use the Skill");
    }

    const baselineSkills = (await this.skills.promoted()).filter((record) => record.id !== skill.id && matchesSkill(record, fixture));
    const actual = ReplayHarness.actualBaseline({
      fixtureId: fixture.id,
      fixtureHash: fixture.integrityHash,
      sourceEpisodeId: fixture.sourceEpisodeId,
      verifierScore: fixture.baseline.verifierScore,
      usage: fixture.baseline.usage,
      turns: fixture.baseline.turns,
      toolCalls: fixture.baseline.toolCalls,
      durationMs: fixture.baseline.elapsedMs,
      activeSkillIds: fixture.baseline.activeSkillIds,
      arm: mode === "production-baseline" ? "baseline" : "candidate",
    });
    const counterfactual = await this.replay.run({
      fixture,
      arm: mode === "production-baseline" ? "candidate" : "baseline",
      repeat: 0,
      skills: mode === "production-baseline" ? [...baselineSkills, skill] : baselineSkills,
    });
    const baseline = mode === "production-baseline" ? actual : counterfactual;
    const candidate = mode === "production-baseline" ? counterfactual : actual;
    const createdAt = new Date().toISOString();
    const observation: ShadowObservation = {
      id: `shadow_${sha256Json({ skillId, episodeId, mode, baseline, candidate }).slice(0, 24)}`,
      skillId,
      episodeId,
      fixtureId: fixture.id,
      mode,
      baseline,
      candidate,
      createdAt,
    };
    const stored = await this.shadow.addObservation(observation);

    if (skill.status === "evaluated") {
      const samples = await this.shadow.observations(skill.id, "production-baseline");
      if (samples.length >= this.options.canaryMinSamples) await this.finalizeCanary(skill.id);
    }
    return stored;
  }

  public async finalizeCanary(skillId: string): Promise<SignedEvaluationReport> {
    const skill = await this.skills.get(skillId);
    if (skill.evaluationReportIds.length === 0) throw new EvolveError("SKILL_GATE", "Canary requires offline evaluation");
    const offlineId = skill.evaluationReportIds.at(-1) as string;
    const offline = await this.reports.requireVerified(offlineId);
    if (!offline.payload.decision.passed || offline.payload.kind !== "offline") {
      throw new EvolveError("SKILL_GATE", "Latest offline evaluation is not a passing signed report");
    }
    const observations = (await this.shadow.observations(skillId, "production-baseline")).filter(
      (observation) => observation.createdAt >= offline.payload.createdAt,
    );
    if (observations.length < this.options.canaryMinSamples) {
      throw new EvolveError(
        "CANARY_SAMPLES",
        `Canary requires ${this.options.canaryMinSamples} independent shadow samples; found ${observations.length}`,
      );
    }
    const policy = defaultEvaluationPolicy({
      ...this.options.policy,
      minFixtures: this.options.canaryMinSamples,
      repeats: 1,
      requireImprovement: false,
    });
    const baselineRuns = observations.map((observation) => observation.baseline);
    const candidateRuns = observations.map((observation) => observation.candidate);
    const metrics = compareRuns(baselineRuns, candidateRuns, policy);
    const fixtures = await Promise.all(observations.map((observation) => this.fixtures.get(observation.fixtureId)));
    const report = await this.reports.create(
      this.payload("canary", skill, fixtures, policy, baselineRuns, candidateRuns, metrics, [
        "Canary traffic was replayed in shadow and never changed the production answer.",
        "Canary requires non-regression; the offline report is responsible for proving improvement.",
      ]),
    );
    await this.skills.attachCanaryReport(skill.id, report.id, report.payload.decision.passed);
    return report;
  }

  public async promoteSkill(skillId: string): Promise<SkillRecord> {
    const skill = await this.skills.get(skillId);
    const offlineId = skill.evaluationReportIds.at(-1);
    const canaryId = skill.canaryReportIds.at(-1);
    if (!offlineId || !canaryId) throw new EvolveError("SKILL_GATE", "Promotion requires offline and canary reports");
    const offline = await this.reports.requireVerified(offlineId);
    const canary = await this.reports.requireVerified(canaryId);
    for (const report of [offline, canary]) {
      if (report.payload.skillId !== skill.id || report.payload.skillFingerprint !== skill.fingerprint) {
        throw new EvolveError("SKILL_GATE", "Evaluation report provenance does not match this Skill");
      }
      if (!report.payload.decision.passed) throw new EvolveError("SKILL_GATE", `${report.payload.kind} evaluation did not pass`);
    }
    if (offline.payload.kind !== "offline" || canary.payload.kind !== "canary") {
      throw new EvolveError("SKILL_GATE", "Promotion report kinds are invalid");
    }
    if (offline.keyFingerprint !== canary.keyFingerprint) {
      throw new EvolveError("SKILL_GATE", "Offline and canary reports were signed by different evaluation authorities");
    }
    return this.skills.promote(skill.id, {
      offlineReportId: offline.id,
      canaryReportId: canary.id,
      policyHash: sha256Json({ offline: offline.payload.policy, canary: canary.payload.policy }),
      keyFingerprint: offline.keyFingerprint,
    });
  }

  public async recordProduction(checkpoint: EpisodeCheckpoint): Promise<SignedEvaluationReport[]> {
    const reports: SignedEvaluationReport[] = [];
    for (const skillId of checkpoint.activeSkillIds ?? []) {
      const skill = await this.skills.get(skillId).catch(() => undefined);
      if (!skill || skill.status !== "promoted") continue;
      const outcome: ProductionOutcome = {
        id: `prod_${sha256Json({ skillId, episodeId: checkpoint.episodeId, status: checkpoint.status }).slice(0, 24)}`,
        skillId,
        episodeId: checkpoint.episodeId,
        createdAt: new Date().toISOString(),
        success: checkpoint.status === "committed",
        verifierScore: checkpoint.finalScore ?? 0,
        usage: checkpoint.usage,
        turns: checkpoint.turns,
        toolCalls: checkpoint.toolCalls,
        status: checkpoint.status,
      };
      await this.shadow.addProduction(outcome);
      const report = await this.monitorSkill(skill.id);
      if (report) reports.push(report);
    }
    return reports;
  }

  public async monitorSkill(skillId: string): Promise<SignedEvaluationReport | undefined> {
    const skill = await this.skills.get(skillId);
    if (skill.status !== "promoted" || !skill.promotion) return undefined;
    const outcomes = await this.shadow.production(skill.id);
    if (outcomes.length < this.options.monitorMinSamples) return undefined;
    const canary = await this.reports.requireVerified(skill.promotion.canaryReportId);
    const observedRuns: ReplayRunResult[] = outcomes.map((outcome, index) => ({
      fixtureId: `production_${outcome.episodeId}`,
      fixtureHash: sha256Json(outcome),
      sourceEpisodeId: outcome.episodeId,
      arm: "candidate",
      repeat: index,
      success: outcome.success,
      verifierScore: outcome.verifierScore,
      usage: outcome.usage,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls,
      durationMs: 0,
      traceMatched: true,
      ...(!outcome.success ? { failureReason: outcome.status } : {}),
      safetyViolations: [],
      activeSkillIds: [skill.id],
    }));
    const observed = aggregateRuns(observedRuns);
    const expected = canary.payload.candidate;
    const comparison = monitorComparison(expected, observed);
    const gates: Record<string, boolean> = {
      minimum_samples: outcomes.length >= this.options.monitorMinSamples,
      success_rate: observed.successRate >= expected.successRate - this.options.monitorMaxSuccessDrop,
      verifier_score: observed.meanVerifierScore >= expected.meanVerifierScore - this.options.monitorMaxScoreDrop,
      token_budget:
        expected.meanTotalTokens === 0 || observed.meanTotalTokens / expected.meanTotalTokens <= this.options.monitorMaxTokenRatio,
    };
    const decision: EvaluationDecision = {
      passed: Object.values(gates).every(Boolean),
      gates,
      reasons: Object.entries(gates)
        .filter(([, passed]) => !passed)
        .map(([gate]) => `Production regression gate failed: ${gate}`),
    };
    if (decision.reasons.length === 0) decision.reasons.push("Production monitor remains within the signed canary envelope");
    const policy = defaultEvaluationPolicy({
      ...this.options.policy,
      minFixtures: this.options.monitorMinSamples,
      requireImprovement: false,
    });
    const payload: EvaluationReportPayload = {
      version: 1,
      engineVersion: "0.3.0",
      kind: "monitor",
      skillId: skill.id,
      skillFingerprint: skill.fingerprint,
      createdAt: new Date().toISOString(),
      fixtureIds: outcomes.map((outcome) => `production_${outcome.episodeId}`),
      fixtureHashes: outcomes.map((outcome) => sha256Json(outcome)),
      policy,
      baselineRuns: [],
      candidateRuns: observedRuns,
      baseline: expected,
      candidate: observed,
      comparison,
      decision,
      metadata: {
        provider: providerName(this.provider),
        notes: ["Production outcomes are compared with the signed canary candidate envelope."],
      },
    };
    const report = await this.reports.create(payload);
    if (!decision.passed) {
      await this.skills.rollback(skill.id, decision.reasons.join("; "), { automatic: true, reportId: report.id });
    }
    return report;
  }

  public async verifyReport(reportId: string): Promise<boolean> {
    return this.reports.verify(reportId);
  }

  private async selectFixtures(
    skill: SkillRecord,
    selection: EvaluationSelection,
    minimum: number,
  ): Promise<ReplayFixture[]> {
    const splits = new Set<FixtureSplit>(selection.splits ?? ["validation", "holdout"]);
    const candidates = selection.fixtures
      ? await Promise.all(selection.fixtures.map((id) => this.fixtures.get(id)))
      : await this.fixtures.list(splits);
    const fixtures = candidates.filter(
      (fixture) => !skill.supportingEpisodes.includes(fixture.sourceEpisodeId) && matchesSkill(skill, fixture),
    );
    if (fixtures.length < minimum) {
      throw new EvolveError(
        "EVAL_FIXTURES",
        `Evaluation requires ${minimum} independent matching fixtures after leakage exclusion; found ${fixtures.length}`,
      );
    }
    return fixtures;
  }

  private payload(
    kind: "offline" | "canary",
    skill: SkillRecord,
    fixtures: ReplayFixture[],
    policy: EvaluationPolicy,
    baselineRuns: ReplayRunResult[],
    candidateRuns: ReplayRunResult[],
    metrics: {
      baseline: EvaluationAggregate;
      candidate: EvaluationAggregate;
      comparison: EvaluationComparison;
      decision: EvaluationDecision;
    },
    notes: string[],
  ): EvaluationReportPayload {
    return {
      version: 1,
      engineVersion: "0.3.0",
      kind,
      skillId: skill.id,
      skillFingerprint: skill.fingerprint,
      createdAt: new Date().toISOString(),
      fixtureIds: fixtures.map((fixture) => fixture.id),
      fixtureHashes: fixtures.map((fixture) => fixture.integrityHash),
      policy,
      baselineRuns,
      candidateRuns,
      baseline: metrics.baseline,
      candidate: metrics.candidate,
      comparison: metrics.comparison,
      decision: metrics.decision,
      metadata: {
        provider: providerName(this.provider),
        notes,
      },
    };
  }
}
