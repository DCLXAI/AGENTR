import type { TaskSpec, Usage } from "../core/types.js";
import type { MemoryStore } from "../memory/memory-store.js";
import type { AgentPrompt, Observation } from "../providers/provider.js";
import type { SkillStore } from "../skills/skill-store.js";
import type { ToolRegistry } from "../tools/registry.js";

export class ContextCompiler {
  public constructor(
    private readonly memory: MemoryStore,
    private readonly skills: SkillStore,
    private readonly tools: ToolRegistry,
  ) {}

  public async compile(input: {
    task: TaskSpec;
    observations: Observation[];
    usage: Usage;
    turns: number;
    toolCalls: number;
    elapsedMs: number;
  }): Promise<AgentPrompt> {
    const memories = await this.memory.search(`${input.task.goal} ${input.task.constraints.join(" ")}`);
    const goalTerms = input.task.goal.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 3);
    const skills = (await this.skills.promoted()).filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.triggers.join(" ")}`.toLowerCase();
      return goalTerms.some((term) => haystack.includes(term));
    });
    const requested = new Set(input.task.requestedTools);
    const tools = this.tools.modelDescriptions().filter((tool) => requested.has(tool.name));
    return {
      task: input.task,
      observations: input.observations.slice(-20),
      memories: memories.slice(0, 8),
      skills: skills.slice(0, 5),
      tools,
      remainingBudget: {
        turns: Math.max(0, input.task.budget.maxTurns - input.turns),
        toolCalls: Math.max(0, input.task.budget.maxToolCalls - input.toolCalls),
        inputTokens: Math.max(0, input.task.budget.maxInputTokens - input.usage.inputTokens),
        outputTokens: Math.max(0, input.task.budget.maxOutputTokens - input.usage.outputTokens),
        wallTimeMs: Math.max(0, input.task.budget.maxWallTimeMs - input.elapsedMs),
      },
    };
  }
}
