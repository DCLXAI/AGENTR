import path from "node:path";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface EvolveConfig {
  home: string;
  workspace: string;
  model: string;
  verifierModel: string;
  reasoningEffort: ReasoningEffort;
  allowedCommands: Set<string>;
  nonInteractive: boolean;
  openAiApiKey?: string;
}

export function loadConfig(
  overrides: Partial<Omit<EvolveConfig, "allowedCommands">> & { allowedCommands?: Iterable<string> } = {},
): EvolveConfig {
  const effort = overrides.reasoningEffort ?? process.env.EVOLVE_REASONING_EFFORT ?? "high";
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new Error(`Invalid reasoning effort: ${effort}`);
  }

  const commands =
    overrides.allowedCommands ??
    (process.env.EVOLVE_ALLOWED_COMMANDS ?? "git,node,npm,npx,pnpm,python,python3,pytest,vitest,tsc").split(",");

  const apiKey = overrides.openAiApiKey ?? process.env.OPENAI_API_KEY;
  return {
    home: path.resolve(overrides.home ?? process.env.EVOLVE_HOME ?? ".evolve"),
    workspace: path.resolve(overrides.workspace ?? process.env.EVOLVE_WORKSPACE ?? "."),
    model: overrides.model ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
    verifierModel: overrides.verifierModel ?? process.env.OPENAI_VERIFIER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.6-sol",
    reasoningEffort: effort as ReasoningEffort,
    allowedCommands: new Set([...commands].map((value) => value.trim()).filter(Boolean)),
    nonInteractive: overrides.nonInteractive ?? process.env.EVOLVE_NON_INTERACTIVE === "true",
    ...(apiKey ? { openAiApiKey: apiKey } : {}),
  };
}
