import { readFile, stat } from "node:fs/promises";
import { atomicWriteFile, pathExists } from "../core/fs.js";
import { sha256Bytes } from "../core/hash.js";
import { EvolveError } from "../core/errors.js";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { booleanArg, rejectUnknownKeys, stringArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description:
    "Create or replace one UTF-8 workspace file. Supports create-only and SHA-256 compare-and-swap guards.",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path" },
      content: { type: "string", description: "Complete UTF-8 file contents" },
      create_only: { type: "boolean", description: "Fail if the file already exists" },
      expected_sha256: {
        type: "string",
        description: "Optional SHA-256 of the current file. The write fails if it changed.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["path", "content", "create_only", "expected_sha256"]);
    const expected = stringArg(args, "expected_sha256", { min: 64, max: 64 });
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) {
      throw new EvolveError("TOOL_ARGS_INVALID", "expected_sha256 must be a lowercase SHA-256 hex digest");
    }
    return {
      path: stringArg(args, "path", { required: true, min: 1, max: 4096 }) as string,
      content: stringArg(args, "content", { required: true, max: 500_000 }) as string,
      create_only: booleanArg(args, "create_only", { fallback: false }) as boolean,
      ...(expected !== undefined ? { expected_sha256: expected } : {}),
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const target = await resolveWorkspacePath(context.workspace, args.path as string, { createParent: true });
    const exists = await pathExists(target);
    if (exists) {
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new EvolveError("WRITE_TARGET_INVALID", "write_file target is not a regular file");
    }
    if ((args.create_only as boolean) && exists) {
      throw new EvolveError("WRITE_CREATE_ONLY", "Target already exists and create_only is true");
    }

    let beforeSha: string | null = null;
    if (exists) beforeSha = sha256Bytes(await readFile(target));
    const expected = args.expected_sha256 as string | undefined;
    if (expected !== undefined && beforeSha !== expected) {
      throw new EvolveError(
        "WRITE_CAS_MISMATCH",
        `Current file hash ${beforeSha ?? "<missing>"} does not match expected_sha256`,
      );
    }

    const content = args.content as string;
    await atomicWriteFile(target, content);
    const afterSha = sha256Bytes(Buffer.from(content, "utf8"));
    return {
      success: true,
      summary: `${exists ? "Replaced" : "Created"} ${displayPath(context.workspace, target)} (${Buffer.byteLength(content)} bytes)`,
      data: {
        path: displayPath(context.workspace, target),
        before_sha256: beforeSha,
        after_sha256: afterSha,
        bytes: Buffer.byteLength(content),
      },
    };
  },
};
