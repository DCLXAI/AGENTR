import { readFile, stat } from "node:fs/promises";
import { sha256Bytes } from "../core/hash.js";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read a UTF-8 workspace file with a byte cap and return its content hash.",
  risk: "read",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      max_bytes: { type: "integer", minimum: 1, maximum: 500000 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["path", "max_bytes"]);
    return {
      path: stringArg(args, "path", { required: true, min: 1, max: 4096 }) as string,
      max_bytes: numberArg(args, "max_bytes", { fallback: 200_000, min: 1, max: 500_000, integer: true }) as number,
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const target = await resolveWorkspacePath(context.workspace, args.path as string);
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new Error("read_file target is not a regular file");
    const buffer = await readFile(target);
    const limit = args.max_bytes as number;
    const slice = buffer.subarray(0, limit);
    const content = slice.toString("utf8");
    return {
      success: true,
      summary: `Read ${displayPath(context.workspace, target)} (${buffer.length} bytes${buffer.length > limit ? ", truncated" : ""})`,
      data: {
        path: displayPath(context.workspace, target),
        content,
        sha256: sha256Bytes(buffer),
        bytes: buffer.length,
        truncated: buffer.length > limit,
      },
    };
  },
};
