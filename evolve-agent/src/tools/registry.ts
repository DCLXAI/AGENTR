import { EvolveError } from "../core/errors.js";
import type { CapabilityAuthority } from "../policy/capability.js";
import { listFilesTool } from "./list-files.js";
import { readFileTool } from "./read-file.js";
import { replaceTextTool } from "./replace-text.js";
import { runProcessTool } from "./run-process.js";
import { searchTextTool } from "./search-text.js";
import type { ToolDefinition, ToolDescription, ToolExecution } from "./types.js";
import { assertObject } from "./validate.js";
import { writeFileTool } from "./write-file.js";

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  public constructor(
    private readonly capabilityAuthority: CapabilityAuthority,
    private readonly context: { workspace: string; allowedCommands: Set<string> },
    tools: ToolDefinition[] = [listFilesTool, readFileTool, searchTextTool, writeFileTool, replaceTextTool, runProcessTool],
  ) {
    for (const tool of tools) {
      if (this.definitions.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.definitions.set(tool.name, tool);
    }
  }

  public has(name: string): boolean {
    return this.definitions.has(name);
  }

  public get(name: string): ToolDefinition {
    const tool = this.definitions.get(name);
    if (!tool) throw new EvolveError("TOOL_UNKNOWN", `Unknown tool: ${name}`);
    return tool;
  }

  public modelDescriptions(): ToolDescription[] {
    return [...this.definitions.values()]
      .map(({ name, description, risk, inputSchema }) => ({ name, description, risk, inputSchema }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  public readOnlyNames(): string[] {
    return [...this.definitions.values()].filter((tool) => tool.risk === "read").map((tool) => tool.name).sort();
  }

  public async execute(input: {
    episodeId: string;
    toolName: string;
    rawArgs: unknown;
    capabilityToken: string;
  }): Promise<{ args: Record<string, unknown>; execution: ToolExecution }> {
    const tool = this.get(input.toolName);
    const args = tool.validate(assertObject(input.rawArgs));
    await this.capabilityAuthority.verify(input.capabilityToken, {
      episodeId: input.episodeId,
      toolName: input.toolName,
      args,
    });
    const execution = await tool.execute(args, this.context);
    return { args, execution };
  }
}
