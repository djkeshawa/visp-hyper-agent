import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Existence probe that distinguishes "absent" from "inaccessible": returns
 * false only on ENOENT and re-throws any other error (permission, I/O, ENOTDIR)
 * so a real problem is never silently reported as "missing".
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * Write a file atomically: stage to a unique sibling temp file, then rename
 * over the destination. A rename on the same filesystem is atomic, so a reader
 * (or a concurrent visp-hyper invocation) never observes a half-written store,
 * and a crash mid-write leaves the previous file intact rather than a truncated
 * one. The temp name is randomized so concurrent writers cannot collide on it.
 */
export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export function vispPath(projectPath: string, ...parts: string[]): string {
  return join(projectPath, ".visp", ...parts);
}

