import type { JsonObject, JsonValue } from "../core/types.js";
import type { ExecutorRegistry } from "../execution/executor-registry.js";

export type ToolRisk = "read" | "write" | "execute" | "external";

export interface ToolContext {
  episodeId: string;
  workspace: string;
  allowedCommands: Set<string>;
  executors: ExecutorRegistry;
}

export interface ToolExecution {
  success: boolean;
  summary: string;
  data: JsonValue;
}

export interface ToolDefinition {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: JsonObject;
  validate(args: Record<string, unknown>): Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecution>;
}

export interface ToolDescription {
  name: string;
  description: string;
  risk: ToolRisk;
  inputSchema: JsonObject;
}
