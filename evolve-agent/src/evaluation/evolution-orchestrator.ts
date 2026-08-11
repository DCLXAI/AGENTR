import { sha256Json } from "../core/hash.js";
import type { EpisodeCheckpoint, SkillRecord } from "../core/types.js";
import type { JsonlLedger } from "../ledger/jsonl-ledger.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { EvaluationEngine } from "./evaluation-engine.js";
import type { FixtureStore } from "./fixture-store.js";

export interface EvolutionOrchestratorOptions {
  captureCommitted: boolean;
  shadowPercent: number;
  monitorPromoted: boolean;
}

function selected(episodeId: string, skillId: string, percent: number): boolean {
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const bucket = Number.parseInt(sha256Json({ episodeId, skillId }).slice(0, 8), 16) / 0xffff_ffff;
  return bucket * 100 < percent;
}

function matches(skill: SkillRecord, goal: string): boolean {
  const normalized = goal.toLowerCase();
  return skill.triggers.some((trigger) => trigger.length >= 3 && normalized.includes(trigger.toLowerCase()));
}

export class EvolutionOrchestrator {
  public constructor(
    private readonly fixtures: FixtureStore,
    private readonly evaluations: EvaluationEngine,
    private readonly skills: SkillStore,
    private readonly ledger: JsonlLedger,
    private readonly options: EvolutionOrchestratorOptions,
  ) {}

  public async observeTerminal(checkpoint: EpisodeCheckpoint): Promise<void> {
    if (checkpoint.status === "committed" && this.options.captureCommitted) {
      try {
        const fixture = await this.fixtures.capture(checkpoint.episodeId);
        await this.ledger.append(checkpoint.episodeId, "evaluation.fixture_captured", {
          fixture_id: fixture.id,
          split: fixture.split,
          integrity_hash: fixture.integrityHash,
        });
      } catch (error: unknown) {
        await this.ledger.append(checkpoint.episodeId, "evaluation.fixture_rejected", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (checkpoint.status === "committed") {
      const skills = await this.skills.list();
      for (const skill of skills) {
        if (!matches(skill, checkpoint.task.goal) || skill.supportingEpisodes.includes(checkpoint.episodeId)) continue;
        if (
          (skill.status === "evaluated" || skill.status === "canary") &&
          selected(checkpoint.episodeId, skill.id, this.options.shadowPercent)
        ) {
          try {
            const observation = await this.evaluations.shadowEpisode(skill.id, checkpoint.episodeId, "production-baseline");
            await this.ledger.append(checkpoint.episodeId, "evaluation.shadow_recorded", {
              skill_id: skill.id,
              observation_id: observation.id,
              mode: observation.mode,
              baseline_success: observation.baseline.success,
              candidate_success: observation.candidate.success,
            });
          } catch (error: unknown) {
            await this.ledger.append(checkpoint.episodeId, "evaluation.shadow_failed", {
              skill_id: skill.id,
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    if (this.options.monitorPromoted && (checkpoint.activeSkillIds?.length ?? 0) > 0) {
      try {
        const reports = await this.evaluations.recordProduction(checkpoint);
        for (const report of reports) {
          await this.ledger.append(checkpoint.episodeId, "evaluation.production_monitor", {
            skill_id: report.payload.skillId,
            report_id: report.id,
            passed: report.payload.decision.passed,
          });
        }
      } catch (error: unknown) {
        await this.ledger.append(checkpoint.episodeId, "evaluation.production_monitor_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
