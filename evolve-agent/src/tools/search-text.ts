import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

const ignored = new Set([".git", ".evolve", "node_modules", "dist", ".test-dist"]);

export const searchTextTool: ToolDefinition = {
  name: "search_text",
  description: "Search UTF-8 workspace files for a literal string and return line-level matches.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: { type: "string" },
      max_results: { type: "integer", minimum: 1, maximum: 200 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["query", "path", "max_results"]);
    return {
      query: stringArg(args, "query", { required: true, min: 1, max: 1000 }) as string,
      path: stringArg(args, "path", { fallback: ".", max: 4096 }) as string,
      max_results: numberArg(args, "max_results", { fallback: 50, min: 1, max: 200, integer: true }) as number,
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const root = await resolveWorkspacePath(context.workspace, args.path as string);
    const query = args.query as string;
    const maxResults = args.max_results as number;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let filesScanned = 0;
    let truncated = false;

    async function scan(target: string): Promise<void> {
      if (truncated) return;
      const metadata = await stat(target);
      if (metadata.isDirectory()) {
        const entries = await readdir(target, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (ignored.has(entry.name)) continue;
          await scan(path.join(target, entry.name));
          if (truncated) return;
        }
        return;
      }
      if (!metadata.isFile() || metadata.size > 1_000_000 || filesScanned >= 1000) return;
      filesScanned += 1;
      const buffer = await readFile(target);
      if (buffer.includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line.includes(query)) {
          matches.push({ path: displayPath(context.workspace, target), line: index + 1, text: line.slice(0, 500) });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      }
    }

    await scan(root);
    return {
      success: true,
      summary: `Found ${matches.length} literal matches for ${JSON.stringify(query)} in ${filesScanned} files${truncated ? " (truncated)" : ""}`,
      data: { matches, files_scanned: filesScanned, truncated },
    };
  },
};
