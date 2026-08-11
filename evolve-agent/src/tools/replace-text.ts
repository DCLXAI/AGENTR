import { readFile, stat } from "node:fs/promises";
import { atomicWriteFile } from "../core/fs.js";
import { sha256Bytes } from "../core/hash.js";
import { EvolveError } from "../core/errors.js";
import type { ToolDefinition, ToolExecution } from "./types.js";
import { numberArg, rejectUnknownKeys, stringArg } from "./validate.js";
import { displayPath, resolveWorkspacePath } from "./workspace.js";

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + Math.max(1, needle.length);
  }
}

export const replaceTextTool: ToolDefinition = {
  name: "replace_text",
  description:
    "Replace an exact text fragment in one UTF-8 workspace file. Fails unless the occurrence count and optional file hash match.",
  risk: "write",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      expected_replacements: { type: "integer", minimum: 1, maximum: 1000 },
      expected_sha256: { type: "string" },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  validate(args) {
    rejectUnknownKeys(args, ["path", "old_text", "new_text", "expected_replacements", "expected_sha256"]);
    const oldText = stringArg(args, "old_text", { required: true, min: 1, max: 200_000 }) as string;
    const expected = stringArg(args, "expected_sha256", { min: 64, max: 64 });
    if (expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) {
      throw new EvolveError("TOOL_ARGS_INVALID", "expected_sha256 must be a lowercase SHA-256 hex digest");
    }
    return {
      path: stringArg(args, "path", { required: true, min: 1, max: 4096 }) as string,
      old_text: oldText,
      new_text: stringArg(args, "new_text", { required: true, max: 200_000 }) as string,
      expected_replacements: numberArg(args, "expected_replacements", {
        fallback: 1,
        min: 1,
        max: 1000,
        integer: true,
      }) as number,
      ...(expected !== undefined ? { expected_sha256: expected } : {}),
    };
  },
  async execute(args, context): Promise<ToolExecution> {
    const target = await resolveWorkspacePath(context.workspace, args.path as string);
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 1_000_000) {
      throw new EvolveError("REPLACE_TARGET_INVALID", "replace_text requires a regular file no larger than 1 MB");
    }
    const before = await readFile(target, "utf8");
    const beforeSha = sha256Bytes(Buffer.from(before, "utf8"));
    const expectedSha = args.expected_sha256 as string | undefined;
    if (expectedSha !== undefined && expectedSha !== beforeSha) {
      throw new EvolveError("REPLACE_CAS_MISMATCH", "File changed since it was read");
    }
    const oldText = args.old_text as string;
    const occurrences = countOccurrences(before, oldText);
    const expectedCount = args.expected_replacements as number;
    if (occurrences !== expectedCount) {
      throw new EvolveError(
        "REPLACE_COUNT_MISMATCH",
        `Expected ${expectedCount} occurrence(s), found ${occurrences}; no write was performed`,
      );
    }
    const after = before.split(oldText).join(args.new_text as string);
    await atomicWriteFile(target, after);
    return {
      success: true,
      summary: `Replaced ${occurrences} occurrence(s) in ${displayPath(context.workspace, target)}`,
      data: {
        path: displayPath(context.workspace, target),
        replacements: occurrences,
        before_sha256: beforeSha,
        after_sha256: sha256Bytes(Buffer.from(after, "utf8")),
      },
    };
  },
};
