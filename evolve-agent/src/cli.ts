#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createRuntime } from "./factory.js";

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

function help(): void {
  console.log(`Evolve Agent 0.2.0 — Hardened Execution

Usage:
  evolve-agent run <goal> [--workspace path] [--tool name ...] [--constraint text ...] [--success text ...]
  evolve-agent resume <episode-id> [--workspace path] [--home path]
  evolve-agent doctor [--executor docker|local] [--allow-local-executor]
  evolve-agent executors list
  evolve-agent secrets sweep
  evolve-agent ledger verify [--home path]
  evolve-agent skills list [--home path]
  evolve-agent skills evaluate <skill-id> [--home path]
  evolve-agent skills canary <skill-id> --score 0.9 --note text --passed [--home path]
  evolve-agent skills promote <skill-id> [--home path]
  evolve-agent skills rollback <skill-id> --note reason [--home path]

Hardened defaults:
  - GPT model: gpt-5.6-sol
  - Docker executor, sha256-pinned image allowlist, --pull never
  - network=none, read-only workspace, read-only root, dropped capabilities
  - CPU, memory, PID, tmpfs, timeout, and output limits
  - short-lived file secrets with output redaction
  - exact human approval for protected actions
  - episode lease with stale-lock recovery
  - local execution is disabled unless --allow-local-executor or EVOLVE_ALLOW_LOCAL_EXECUTOR=true is set.`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const [command, subcommand, third] = parsed.positionals;
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
          version: "0.2.0",
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
    console.log(
      JSON.stringify(
        {
          default: bundle.executors.getDefaultKind(),
          probes: await bundle.executors.probeAll(),
        },
        null,
        2,
      ),
    );
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

  if (command === "skills" && subcommand === "list") {
    console.log(JSON.stringify(await bundle.skills.list(), null, 2));
    return;
  }

  if (command === "skills" && subcommand === "evaluate" && third) {
    console.log(
      JSON.stringify(
        await bundle.skills.evaluate(third, new Set(bundle.tools.modelDescriptions().map((tool) => tool.name))),
        null,
        2,
      ),
    );
    return;
  }

  if (command === "skills" && subcommand === "canary" && third) {
    const score = numeric(parsed, "score");
    const note = value(parsed, "note");
    if (score === undefined || !note) throw new Error("canary requires --score and --note");
    console.log(JSON.stringify(await bundle.skills.recordCanary(third, parsed.flags.has("passed"), score, note), null, 2));
    return;
  }

  if (command === "skills" && subcommand === "promote" && third) {
    console.log(JSON.stringify(await bundle.skills.promote(third), null, 2));
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
