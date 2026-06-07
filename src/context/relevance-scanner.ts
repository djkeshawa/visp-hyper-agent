import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { isBlockedPath } from "../governance/blocked-files.js";
import type { ContextFile } from "../core/types.js";

const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"]);
const configFiles = new Set([
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "tsup.config.ts"
]);

export function keywordsForGoal(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

export async function scanRelevantFiles(input: {
  projectPath: string;
  goal: string;
  blockedPaths: string[];
  maxFiles?: number;
}): Promise<ContextFile[]> {
  const keywords = keywordsForGoal(input.goal);
  const files = await listFiles(input.projectPath, input.blockedPaths);
  const selected = files
    .map((file) => scoreFile(file, keywords))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.maxFiles ?? 20);

  const result: ContextFile[] = [];
  for (const item of selected) {
    result.push({
      path: item.path,
      reason: item.reason,
      content: await readSmallText(join(input.projectPath, item.path))
    });
  }
  return result;
}

async function listFiles(projectPath: string, blockedPaths: string[]): Promise<string[]> {
  const output: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const path = relative(projectPath, absolute);
      if (isBlockedPath(path, blockedPaths)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        output.push(path);
      }
    }
  }

  await walk(projectPath);
  return output;
}

function scoreFile(path: string, keywords: string[]): { path: string; score: number; reason: string } {
  if (configFiles.has(path)) {
    return { path, score: 10, reason: "project config or README" };
  }

  const lower = path.toLowerCase();
  const matches = keywords.filter((keyword) => lower.includes(keyword));
  if (matches.length > 0) {
    return { path, score: matches.length * 5, reason: `matched goal keywords: ${matches.join(", ")}` };
  }

  return { path, score: 0, reason: "not selected" };
}

async function readSmallText(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > 12_000 ? `${content.slice(0, 12_000)}\n\n[truncated]\n` : content;
  } catch {
    return undefined;
  }
}

