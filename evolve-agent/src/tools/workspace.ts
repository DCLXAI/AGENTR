import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { EvolveError } from "../core/errors.js";

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function nearestExistingParent(target: string): Promise<string> {
  let current = target;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function rejectSymlinks(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === "") return;
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new EvolveError("WORKSPACE_SYMLINK", `Symlink traversal is not allowed: ${current}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function resolveWorkspacePath(workspace: string, requested = ".", options: { createParent?: boolean } = {}): Promise<string> {
  await mkdir(workspace, { recursive: true });
  const root = await realpath(workspace);
  const lexical = path.resolve(root, requested);
  if (!contained(root, lexical)) throw new EvolveError("WORKSPACE_ESCAPE", `Path escapes workspace: ${requested}`);
  await rejectSymlinks(root, lexical);

  const existing = await nearestExistingParent(lexical);
  const canonicalParent = await realpath(existing);
  if (!contained(root, canonicalParent)) throw new EvolveError("WORKSPACE_ESCAPE", `Canonical path escapes workspace: ${requested}`);

  if (options.createParent) {
    const parent = path.dirname(lexical);
    await mkdir(parent, { recursive: true });
    await rejectSymlinks(root, parent);
  }
  return lexical;
}

export function displayPath(workspace: string, absolute: string): string {
  const relative = path.relative(workspace, absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}
