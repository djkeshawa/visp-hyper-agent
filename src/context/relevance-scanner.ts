import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { isBlockedPath } from "../governance/blocked-files.js";
import type { ContextFile } from "../core/types.js";

const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"]);
const maxContentLength = 12_000;
const configFiles = new Set([
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vitest.config.ts",
  "tsup.config.ts",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle"
]);
const artifactDirs = [
  ".visp/specs",
  ".visp/tasks",
  ".visp/rules",
  ".visp/plans"
];
const artifactFiles = [
  ".visp/constitution.md"
];

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
  const fileSet = new Set(files);
  const references = await readArtifactReferences(input.projectPath, fileSet);
  const scored = new Map<string, ScoredFile>();

  for (const file of files) {
    mergeScore(scored, scoreFile(file, keywords, references));
  }

  for (const item of [...scored.values()].filter((item) => item.score > 0)) {
    for (const testPath of likelyTestFiles(item.path, fileSet)) {
      mergeScore(scored, {
        path: testPath,
        score: Math.max(item.score - 1, 1),
        reason: `likely test for ${item.path}`
      });
    }
  }

  const selected = [...scored.values()]
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

type ScoredFile = { path: string; score: number; reason: string };

async function listFiles(projectPath: string, blockedPaths: string[]): Promise<string[]> {
  const output: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
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

function scoreFile(path: string, keywords: string[], references: Set<string>): ScoredFile {
  if (configFiles.has(path)) {
    return { path, score: 10, reason: "project config or README" };
  }

  const lower = path.toLowerCase();
  const matches = keywords.filter((keyword) => lower.includes(keyword));
  const referenced = references.has(path);
  if (matches.length > 0 && referenced) {
    return {
      path,
      score: matches.length * 5 + 8,
      reason: `matched goal keywords and Visp-Kit artifact reference: ${matches.join(", ")}`
    };
  }
  if (matches.length > 0) {
    return { path, score: matches.length * 5, reason: `matched goal keywords: ${matches.join(", ")}` };
  }
  if (referenced) {
    return { path, score: 8, reason: "referenced by Visp-Kit artifact" };
  }

  return { path, score: 0, reason: "not selected" };
}

function mergeScore(scored: Map<string, ScoredFile>, item: ScoredFile): void {
  const existing = scored.get(item.path);
  if (!existing || item.score > existing.score) {
    scored.set(item.path, item);
  } else if (item.score === existing.score && !existing.reason.includes(item.reason)) {
    scored.set(item.path, { ...existing, reason: `${existing.reason}; ${item.reason}` });
  }
}

async function readArtifactReferences(projectPath: string, fileSet: Set<string>): Promise<Set<string>> {
  const references = new Set<string>();
  const artifactPaths = [
    ...artifactFiles,
    ...(await artifactMarkdownFiles(projectPath))
  ];

  for (const artifactPath of artifactPaths) {
    const content = await readSmallText(join(projectPath, artifactPath));
    if (!content) {
      continue;
    }
    for (const file of fileSet) {
      if (content.includes(file)) {
        references.add(file);
      }
    }
  }
  return references;
}

async function artifactMarkdownFiles(projectPath: string): Promise<string[]> {
  const output: string[] = [];
  for (const dir of artifactDirs) {
    let entries;
    try {
      entries = await readdir(join(projectPath, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        output.push(`${dir}/${entry.name}`);
      }
    }
  }
  return output;
}

function likelyTestFiles(path: string, fileSet: Set<string>): string[] {
  if (isTestPath(path)) {
    return [];
  }

  const ext = extname(path);
  const name = basename(path, ext);
  const candidates = [
    join("tests", `${name}.test${ext}`),
    join("tests", `${name}.spec${ext}`),
    join(dirname(path), `${name}.test${ext}`),
    join(dirname(path), `${name}.spec${ext}`)
  ];

  return candidates.filter((candidate) => fileSet.has(candidate));
}

function isTestPath(path: string): boolean {
  return /(^tests\/|\.test\.|\.spec\.)/u.test(path);
}

async function readSmallText(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxContentLength ? `${content.slice(0, maxContentLength)}\n\n[truncated]\n` : content;
  } catch {
    return undefined;
  }
}
