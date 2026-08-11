import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    const handle = await open(target, "r");
    await handle.close();
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJsonFile<T>(target: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function atomicWriteFile(target: string, content: string | Buffer, mode?: number): Promise<void> {
  await ensureDir(path.dirname(target));
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temp, content, mode === undefined ? undefined : { mode });
  await rename(temp, target);
}

export async function atomicWriteJson(target: string, value: unknown, mode?: number): Promise<void> {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, mode);
}
