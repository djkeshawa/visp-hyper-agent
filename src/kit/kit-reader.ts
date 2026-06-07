import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { KitArtifacts } from "../core/types.js";

export async function readKitArtifacts(projectPath: string): Promise<KitArtifacts> {
  return {
    constitution: await readOptional(join(projectPath, ".visp", "constitution.md")),
    rules: await readMarkdownDir(projectPath, ".visp/rules"),
    specs: await readMarkdownDir(projectPath, ".visp/specs"),
    tasks: await readMarkdownDir(projectPath, ".visp/tasks"),
    plans: await readMarkdownDir(projectPath, ".visp/plans")
  };
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readMarkdownDir(projectPath: string, dir: string): Promise<Array<{ path: string; content: string }>> {
  const absolute = join(projectPath, dir);
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const result = [];
    for (const file of files) {
      const path = join(absolute, file.name);
      result.push({ path: relative(projectPath, path), content: await readFile(path, "utf8") });
    }
    return result;
  } catch {
    return [];
  }
}

