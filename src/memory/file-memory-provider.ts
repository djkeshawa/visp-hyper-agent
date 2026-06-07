import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { MemoryPack } from "../core/types.js";
import { ensureDir, writeText } from "../core/fs-utils.js";

export async function readMemoryPack(projectPath: string): Promise<MemoryPack> {
  const memoryPath = join(projectPath, ".visp", "memory");
  await ensureDir(join(memoryPath, "session-history"));
  const files = await readMarkdownTree(projectPath, memoryPath);
  return { files };
}

export async function writeSessionMemory(input: {
  projectPath: string;
  sessionId: string;
  goal: string;
  summary: string;
}): Promise<string> {
  const path = join(input.projectPath, ".visp", "memory", "session-history", `${input.sessionId}.md`);
  await writeText(
    path,
    [
      `# Session ${input.sessionId}`,
      "",
      `Goal: ${input.goal}`,
      "",
      "## Summary",
      "",
      input.summary,
      ""
    ].join("\n")
  );
  return path;
}

async function readMarkdownTree(
  projectPath: string,
  dir: string
): Promise<Array<{ path: string; content: string }>> {
  const result: Array<{ path: string; content: string }> = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push({ path: relative(projectPath, absolute), content: await readFile(absolute, "utf8") });
      }
    }
  }
  await walk(dir);
  return result;
}

