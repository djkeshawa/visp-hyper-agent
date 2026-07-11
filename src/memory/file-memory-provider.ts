import { appendFile, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  ArtifactFile,
  DecisionRecord,
  MemoryPack,
  MemoryProvider,
  MemoryRecord,
  MemoryResult,
  ProjectMemoryProfile,
  RecallOptions
} from "../core/types.js";
import { ensureDir, writeText } from "../core/fs-utils.js";
import { toPosixPath } from "../core/path-utils.js";

export async function readMemoryPack(projectPath: string): Promise<MemoryPack> {
  const provider = new FileMemoryProvider(projectPath);
  return provider.readPack();
}

export async function writeSessionMemory(input: {
  projectPath: string;
  sessionId: string;
  goal: string;
  summary: string;
  timestamp?: string;
  changedFiles?: string[];
  reviewSummary?: string;
  decisions?: string[];
  followUps?: string[];
}): Promise<string> {
  const provider = new FileMemoryProvider(input.projectPath);
  await provider.remember(input);
  return sessionMemoryPath(input.projectPath, input.sessionId);
}

export class FileMemoryProvider implements MemoryProvider {
  constructor(private readonly projectPath: string) {}

  async readPack(): Promise<MemoryPack> {
    const memoryPath = join(this.projectPath, ".visp", "memory");
    const warnings: string[] = [];
    await ensureDir(join(memoryPath, "session-history"));
    const files = await readMarkdownTree(this.projectPath, memoryPath);
    if (files.length === 0) {
      warnings.push("No local Visp memory markdown files found.");
    }
    return { files, warnings };
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryResult[]> {
    const pack = await this.readPack();
    const terms = query.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    const matches = pack.files.filter((file) => {
      const content = `${file.path}\n${file.content}`.toLowerCase();
      return terms.length === 0 || terms.some((term) => content.includes(term));
    });
    return matches.slice(0, options.limit ?? 10);
  }

  async remember(record: MemoryRecord): Promise<void> {
    const path = sessionMemoryPath(this.projectPath, record.sessionId);
    await writeText(path, renderSessionMemory(record));
  }

  async storeDecision(decision: DecisionRecord): Promise<void> {
    const path = join(this.projectPath, ".visp", "memory", "architecture-decisions.md");
    await ensureDir(join(this.projectPath, ".visp", "memory"));
    await appendFile(path, renderDecision(decision), "utf8");
  }

  async getProjectProfile(projectPath: string): Promise<ProjectMemoryProfile | null> {
    const path = join(projectPath, ".visp", "memory", "project-summary.md");
    try {
      return { projectPath, summary: await readFile(path, "utf8") };
    } catch {
      return null;
    }
  }
}

function sessionMemoryPath(projectPath: string, sessionId: string): string {
  return join(projectPath, ".visp", "memory", "session-history", `${sessionId}.md`);
}

function renderSessionMemory(record: MemoryRecord): string {
  const timestamp = record.timestamp ?? new Date().toISOString();
  return [
    `# Session ${record.sessionId}`,
    "",
    `Goal: ${record.goal}`,
    `Timestamp: ${timestamp}`,
    "",
    "## Summary",
    "",
    record.summary,
    "",
    "## Changed Files",
    "",
    ...listOrNone(record.changedFiles),
    "",
    "## Review Summary",
    "",
    record.reviewSummary?.trim() || "No review summary recorded.",
    "",
    "## Decisions",
    "",
    ...listOrNone(record.decisions),
    "",
    "## Follow-ups",
    "",
    ...listOrNone(record.followUps),
    ""
  ].join("\n");
}

function renderDecision(decision: DecisionRecord): string {
  return [
    "",
    `## ${decision.title}`,
    "",
    `Timestamp: ${decision.timestamp ?? new Date().toISOString()}`,
    "",
    decision.decision,
    ""
  ].join("\n");
}

function listOrNone(values: string[] | undefined): string[] {
  return values && values.length > 0 ? values.map((value) => `- ${value}`) : ["_None recorded._"];
}

async function readMarkdownTree(projectPath: string, dir: string): Promise<ArtifactFile[]> {
  const result: ArtifactFile[] = [];
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
        const content = await readFile(absolute, "utf8");
        result.push({ path: toPosixPath(relative(projectPath, absolute)), content, summary: summarize(content) });
      }
    }
  }
  await walk(dir);
  return result;
}

function summarize(content: string): string {
  const firstText = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  return firstText ? firstText.slice(0, 220) : "No summary content.";
}
