import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

const ignored = new Set([".git", ".evolve", "node_modules", "dist", ".test-dist"]);

export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description: "List workspace files and directories recursively with strict depth and entry limits.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative directory" },
      depth: { type: "integer", minimum: 0, maximum: 6 },
      max_entries: { type: "integer", minimum: 1, maximum: 1000 },
    },
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["path", "depth", "max_entries"]);
    return {
      path: stringArg(args, "path", { fallback: ".", max: 4096 }) as string,
      depth: numberArg(args, "depth", { fallback: 2, min: 0, max: 6, integer: true }) as number,
      max_entries: numberArg(args, "max_entries", { fallback: 300, min: 1, max: 1000, integer: true }) as number,
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const target = await resolveWorkspacePath(context.workspace, args.path as string);
    const output: string[] = [];
    let truncated = false;
    const maxEntries = args.max_entries as number;

    async function visit(directory: string, depth: number): Promise<void> {
      if (truncated) return;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (ignored.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        output.push(`${displayPath(context.workspace, absolute)}${entry.isDirectory() ? "/" : ""}`);
        if (output.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (entry.isDirectory() && depth > 0) await visit(absolute, depth - 1);
      }
    }

    await visit(target, args.depth as number);
    return {
      success: true,
      summary: `Listed ${output.length} entries under ${displayPath(context.workspace, target)}${truncated ? " (truncated)" : ""}`,
      data: { entries: output, truncated },
    };
  },
};
