#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { createRuntime } from "./factory.js";
import type { FixtureSplit, ShadowObservation } from "./evaluation/types.js";

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const values: string[] = [];
    while (index + 1 < args.length && !args[index + 1]?.startsWith("--")) {
      values.push(args[index + 1] as string);
      index += 1;
    }
    if (values.length === 0) flags.add(key);
    else options.set(key, [...(options.get(key) ?? []), ...values]);
  }
  return { positionals, options, flags };
}

function value(parsed: ParsedArgs, key: string): string | undefined {
  return parsed.options.get(key)?.[0];
}

function values(parsed: ParsedArgs, key: string): string[] {
  return parsed.options.get(key) ?? [];
}

function numeric(parsed: ParsedArgs, key: string): number | undefined {
  const raw = value(parsed, key);
  if (raw === undefined) return undefined;
  const parsedNumber = Number(raw);
  if (!Number.isFinite(parsedNumber) || parsedNumber <= 0) throw new Error(`--${key} must be a positive number`);
  return parsedNumber;
}

function fixtureSplits(parsed: ParsedArgs): FixtureSplit[] | undefined {
  const requested = values(parsed, "split");
  if (requested.length === 0) return undefined;
  for (const split of requested) {
    if (split !== "train" && split !== "validation" && split !== "holdout") {
      throw new Error(`Unknown fixture split: ${split}`);
    }
  }
  return requested as FixtureSplit[];
}

function help(): void {
  console.log(`Evolve Agent 0.3.0 — Evaluation-Driven Evolution

Usage:
  evolve-agent run <goal> [--workspace path] [--tool name ...] [--constraint text ...] [--success text ...]
  evolve-agent resume <episode-id> [--workspace path] [--home path]
  evolve-agent doctor [--executor docker|local] [--allow-local-executor]
  evolve-agent executors list
  evolve-agent secrets sweep
  evolve-agent ledger verify

Evaluation fixtures:
  evolve-agent evaluations fixtures capture <episode-id> [--split train|validation|holdout]
  evolve-agent evaluations fixtures import <path>
  evolve-agent evaluations fixtures list [--split validation --split holdout]

Counterfactual evaluation:
  evolve-agent evaluations run <skill-id> [--fixture id ...] [--split validation --split holdout] [--repeats N]
  evolve-agent evaluations shadow <skill-id> <episode-id> [--mode production-baseline|production-candidate]
  evolve-agent evaluations canary <skill-id>
  evolve-agent evaluations monitor <skill-id>
  evolve-agent evaluations reports list
  evolve-agent evaluations reports show <report-id>
  evolve-agent evaluations verify <report-id>

Skill lifecycle:
  evolve-agent skills list
  evolve-agent skills evaluate <skill-id> [evaluation selection options]
  evolve-agent skills promote <skill-id>
  evolve-agent skills rollback <skill-id> --note reason

Evolution invariants:
  - supporting Episodes are excluded from evaluation fixtures
  - baseline and candidate receive the same replay trace, tools, budgets, and verifier
  - signed offline and shadow-canary reports are required for explicit promotion
  - candidate Skills never alter production answers during shadow evaluation
  - promoted Skills are automatically rolled back when the production window breaches the signed canary envelope
  - Docker remains the default fail-closed execution boundary from v0.2`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, third, fourth] = parsed.positionals;
  if (!command || command === "help" || parsed.flags.has("help")) {
    help();
    return;
  }

  const configuredExecutor = value(parsed, "executor");
  const config = loadConfig({
    ...(value(parsed, "workspace") !== undefined ? { workspace: value(parsed, "workspace") as string } : {}),
    ...(value(parsed, "home") !== undefined ? { home: value(parsed, "home") as string } : {}),
    ...(value(parsed, "model") !== undefined ? { model: value(parsed, "model") as string } : {}),
    ...(configuredExecutor !== undefined ? { defaultExecutor: configuredExecutor as "docker" | "local" } : {}),
    ...(parsed.flags.has("allow-local-executor") ? { allowLocalExecutor: true } : {}),
    ...(parsed.flags.has("non-interactive") ? { nonInteractive: true } : {}),
  });
  const bundle = createRuntime(config);

  if (command === "doctor") {
    const expiredSecretsRemoved = await bundle.secrets.sweepExpired();
    const probes = await bundle.executors.probeAll();
    const defaultProbe = probes.find((probe) => probe.kind === bundle.executors.getDefaultKind());
    const providerReady = Boolean(config.openAiApiKey);
    const hardenedExecutionReady = config.defaultExecutor === "docker" && Boolean(defaultProbe?.ready);
    const ok = providerReady && hardenedExecutionReady;
    console.log(
      JSON.stringify(
        {
          ok,
          version: "0.3.0",
          model: config.model,
          verifier_model: config.verifierModel,
          workspace: config.workspace,
          home: config.home,
          api_key_configured: providerReady,
          default_executor: bundle.executors.getDefaultKind(),
          hardened_execution_ready: hardenedExecutionReady,
          local_executor_enabled: bundle.executors.list().includes("local"),
          docker: {
            default_image: config.docker.defaultImage ?? null,
            allowed_images: [...config.docker.allowedImages].sort(),
            allowed_networks: [...config.docker.allowedNetworks].sort(),
            non_root_user: config.docker.user,
            require_rootless: config.docker.requireRootless,
            maximums: config.docker.maximums,
          },
          evaluation: {
            capture_committed: config.evaluation.captureCommitted,
            shadow_percent: config.evaluation.shadowPercent,
            monitor_promoted: config.evaluation.monitorPromoted,
            canary_min_samples: config.evaluation.canaryMinSamples,
            monitor_min_samples: config.evaluation.monitorMinSamples,
            monitor_window: config.evaluation.monitorWindow,
            policy: config.evaluation.policy,
            fixtures: (await bundle.fixtures.list()).length,
            reports: (await bundle.reports.list()).length,
          },
          secret_allowlist: bundle.secrets.allowedNames(),
          expired_secret_leases_removed: expiredSecretsRemoved,
          episode_lease: {
            ttl_ms: config.leaseTtlMs,
            heartbeat_ms: config.leaseHeartbeatMs,
          },
          executors: probes,
          tools: bundle.tools.modelDescriptions(),
        },
        null,
        2,
      ),
    );
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (command === "executors" && subcommand === "list") {
    console.log(JSON.stringify({ default: bundle.executors.getDefaultKind(), probes: await bundle.executors.probeAll() }, null, 2));
    return;
  }

  if (command === "secrets" && subcommand === "sweep") {
    console.log(JSON.stringify({ removed: await bundle.secrets.sweepExpired() }, null, 2));
    return;
  }

  if (command === "run") {
    const goal = subcommand;
    if (!goal) throw new Error("run requires a goal. Quote multi-word goals.");
    const selectedTools = values(parsed, "tool");
    const result = await bundle.runtime.run({
      goal,
      constraints: values(parsed, "constraint"),
      successCriteria: values(parsed, "success"),
      ...(selectedTools.length > 0 ? { requestedTools: selectedTools } : {}),
      budget: {
        ...(numeric(parsed, "max-turns") !== undefined ? { maxTurns: numeric(parsed, "max-turns") as number } : {}),
        ...(numeric(parsed, "max-tool-calls") !== undefined
          ? { maxToolCalls: numeric(parsed, "max-tool-calls") as number }
          : {}),
        ...(numeric(parsed, "max-wall-ms") !== undefined ? { maxWallTimeMs: numeric(parsed, "max-wall-ms") as number } : {}),
      },
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "committed" ? 0 : 1;
    return;
  }

  if (command === "resume" && subcommand) {
    const result = await bundle.runtime.resume(subcommand);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "committed" ? 0 : 1;
    return;
  }

  if (command === "ledger" && subcommand === "verify") {
    const result = await bundle.ledger.verify();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (command === "evaluations" && subcommand === "fixtures" && third === "capture" && fourth) {
    const split = fixtureSplits(parsed)?.[0];
    console.log(JSON.stringify(await bundle.fixtures.capture(fourth, split), null, 2));
    return;
  }

  if (command === "evaluations" && subcommand === "fixtures" && third === "import" && fourth) {
    const fixture = JSON.parse(await readFile(fourth, "utf8")) as unknown;
    console.log(JSON.stringify(await bundle.fixtures.import(fixture), null, 2));
    return;
  }

  if (command === "evaluations" && subcommand === "fixtures" && third === "list") {
    const splits = fixtureSplits(parsed);
    console.log(JSON.stringify(await bundle.fixtures.list(splits ? new Set(splits) : undefined), null, 2));
    return;
  }

  if ((command === "evaluations" && subcommand === "run" && third) || (command === "skills" && subcommand === "evaluate" && third)) {
    const skillId = third as string;
    const report = await bundle.evaluations.evaluateSkill(skillId, {
      ...(values(parsed, "fixture").length > 0 ? { fixtures: values(parsed, "fixture") } : {}),
      ...(fixtureSplits(parsed) ? { splits: fixtureSplits(parsed) as FixtureSplit[] } : {}),
      ...(numeric(parsed, "repeats") !== undefined ? { repeats: Math.floor(numeric(parsed, "repeats") as number) } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.payload.decision.passed ? 0 : 1;
    return;
  }

  if (command === "evaluations" && subcommand === "shadow" && third && fourth) {
    const mode = value(parsed, "mode");
    if (mode !== undefined && mode !== "production-baseline" && mode !== "production-candidate") {
      throw new Error(`Invalid shadow mode: ${mode}`);
    }
    console.log(
      JSON.stringify(
        await bundle.evaluations.shadowEpisode(
          third,
          fourth,
          mode as ShadowObservation["mode"] | undefined,
        ),
        null,
        2,
      ),
    );
    return;
  }

  if (command === "evaluations" && subcommand === "canary" && third) {
    const report = await bundle.evaluations.finalizeCanary(third);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.payload.decision.passed ? 0 : 1;
    return;
  }

  if (command === "evaluations" && subcommand === "monitor" && third) {
    console.log(JSON.stringify((await bundle.evaluations.monitorSkill(third)) ?? { status: "insufficient_samples" }, null, 2));
    return;
  }

  if (command === "evaluations" && subcommand === "reports" && third === "list") {
    console.log(JSON.stringify(await bundle.reports.list(), null, 2));
    return;
  }

  if (command === "evaluations" && subcommand === "reports" && third === "show" && fourth) {
    console.log(JSON.stringify(await bundle.reports.get(fourth), null, 2));
    return;
  }

  if (command === "evaluations" && subcommand === "verify" && third) {
    const valid = await bundle.evaluations.verifyReport(third);
    console.log(JSON.stringify({ report_id: third, valid }, null, 2));
    process.exitCode = valid ? 0 : 1;
    return;
  }

  if (command === "skills" && subcommand === "list") {
    console.log(JSON.stringify(await bundle.skills.list(), null, 2));
    return;
  }

  if (command === "skills" && subcommand === "promote" && third) {
    console.log(JSON.stringify(await bundle.evaluations.promoteSkill(third), null, 2));
    return;
  }

  if (command === "skills" && subcommand === "rollback" && third) {
    const note = value(parsed, "note");
    if (!note) throw new Error("rollback requires --note");
    console.log(JSON.stringify(await bundle.skills.rollback(third, note), null, 2));
    return;
  }

  throw new Error("Unknown command. Run `evolve-agent help`.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
