import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
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

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export function vispPath(projectPath: string, ...parts: string[]): string {
  return join(projectPath, ".visp", ...parts);
}

