import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ArtifactFile, KitArtifacts } from "../core/types.js";

export async function readKitArtifacts(projectPath: string): Promise<KitArtifacts> {
  const warnings: string[] = [];
  const constitution = await readArtifact(projectPath, ".visp/constitution.md");
  if (!constitution) {
    warnings.push("Missing .visp/constitution.md.");
  }

  return {
    constitution,
    rules: await readMarkdownDir(projectPath, ".visp/rules", warnings),
    specs: await readMarkdownDir(projectPath, ".visp/specs", warnings),
    tasks: await readMarkdownDir(projectPath, ".visp/tasks", warnings),
    plans: await readMarkdownDir(projectPath, ".visp/plans", warnings),
    warnings
  };
}

async function readArtifact(projectPath: string, path: string): Promise<ArtifactFile | undefined> {
  try {
    const content = await readFile(join(projectPath, path), "utf8");
    return { path, content, summary: summarize(content) };
  } catch {
    return undefined;
  }
}

async function readMarkdownDir(projectPath: string, dir: string, warnings: string[]): Promise<ArtifactFile[]> {
  const absolute = join(projectPath, dir);
  try {
    const entries = await readdir(absolute, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"));
    const result: ArtifactFile[] = [];
    for (const file of files) {
      const path = join(absolute, file.name);
      const content = await readFile(path, "utf8");
      result.push({ path: relative(projectPath, path), content, summary: summarize(content) });
    }
    return result;
  } catch {
    warnings.push(`Missing ${dir}.`);
    return [];
  }
}

function summarize(content: string): string {
  const firstText = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return firstText ? firstText.slice(0, 220) : "No summary content.";
}
