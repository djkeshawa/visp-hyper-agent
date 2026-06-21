import { createHash } from "node:crypto";
import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";

const failurePatternSchema = z.object({
  id: z.string(),
  signature: z.string(),
  taskId: z.string(),
  taskClass: z.string(),
  sessionId: z.string(),
  source: z.enum(["kit", "local"]),
  verifyPassed: z.boolean(),
  reviewPassed: z.boolean(),
  findings: z.array(z.string()),
  relatedFiles: z.array(z.string()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  occurrences: z.number().int().positive()
});

const storeSchema = z.object({
  version: z.literal(1),
  patterns: z.array(failurePatternSchema)
});

export type FailurePattern = z.infer<typeof failurePatternSchema>;

type FailurePatternStore = z.infer<typeof storeSchema>;

export type FailurePatternInput = {
  taskId: string;
  taskClass: string;
  sessionId: string;
  source: "kit" | "local";
  verifyPassed: boolean;
  reviewPassed: boolean;
  findings: readonly string[];
  relatedFiles: readonly string[];
  at?: string;
};

export type FailurePatternQuery = {
  goal?: string;
  taskId?: string | null;
  taskClass?: string | null;
  files?: readonly string[];
  limit?: number;
};

type ScoredFailurePatternQuery = Omit<FailurePatternQuery, "files"> & {
  files: Set<string>;
  terms: string[];
};

const STORE_PATH = ["hyper", "failure-patterns.json"];
const MAX_PATTERNS = 100;

export async function recordFailurePattern(
  projectPath: string,
  input: FailurePatternInput
): Promise<FailurePattern> {
  const now = input.at ?? new Date().toISOString();
  const findings = unique(input.findings.map(cleanText).filter(Boolean));
  const relatedFiles = unique(input.relatedFiles.map(cleanText).filter(Boolean)).sort();
  const signature = patternSignature({
    taskClass: input.taskClass,
    source: input.source,
    findings
  });
  const store = await readFailurePatternStore(projectPath);
  const existing = store.patterns.find((pattern) => pattern.signature === signature);
  if (existing) {
    const next = {
      ...existing,
      taskId: input.taskId,
      taskClass: input.taskClass,
      sessionId: input.sessionId,
      verifyPassed: input.verifyPassed,
      reviewPassed: input.reviewPassed,
      findings,
      relatedFiles: unique([...existing.relatedFiles, ...relatedFiles]).sort(),
      lastSeenAt: now,
      occurrences: existing.occurrences + 1
    };
    store.patterns = store.patterns.map((pattern) => pattern.id === existing.id ? next : pattern);
    await writeFailurePatternStore(projectPath, trimStore(store));
    return next;
  }

  const created: FailurePattern = {
    id: `fp_${signature.slice(0, 12)}`,
    signature,
    taskId: input.taskId,
    taskClass: input.taskClass,
    sessionId: input.sessionId,
    source: input.source,
    verifyPassed: input.verifyPassed,
    reviewPassed: input.reviewPassed,
    findings,
    relatedFiles,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrences: 1
  };
  store.patterns.push(created);
  await writeFailurePatternStore(projectPath, trimStore(store));
  return created;
}

export async function readRelevantFailurePatterns(
  projectPath: string,
  query: FailurePatternQuery = {}
): Promise<FailurePattern[]> {
  const store = await readFailurePatternStore(projectPath);
  const limit = query.limit ?? 5;
  const files = new Set(query.files ?? []);
  const terms = (query.goal ?? "").toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  return store.patterns
    .map((pattern) => ({ pattern, score: relevanceScore(pattern, { ...query, files, terms }) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.pattern.lastSeenAt.localeCompare(left.pattern.lastSeenAt)
    )
    .slice(0, limit)
    .map((entry) => entry.pattern);
}

async function readFailurePatternStore(projectPath: string): Promise<FailurePatternStore> {
  const raw = await readTextIfExists(vispPath(projectPath, ...STORE_PATH));
  if (!raw) {
    return { version: 1, patterns: [] };
  }
  try {
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { version: 1, patterns: [] };
  } catch {
    return { version: 1, patterns: [] };
  }
}

async function writeFailurePatternStore(projectPath: string, store: FailurePatternStore): Promise<void> {
  await writeText(vispPath(projectPath, ...STORE_PATH), `${JSON.stringify(store, null, 2)}\n`);
}

function trimStore(store: FailurePatternStore): FailurePatternStore {
  return {
    version: 1,
    patterns: [...store.patterns]
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
      .slice(0, MAX_PATTERNS)
  };
}

function relevanceScore(
  pattern: FailurePattern,
  query: ScoredFailurePatternQuery
): number {
  let score = 0;
  if (query.taskId && pattern.taskId === query.taskId) {
    score += 5;
  }
  if (query.taskClass && pattern.taskClass === query.taskClass) {
    score += 2;
  }
  for (const file of pattern.relatedFiles) {
    if (query.files.has(file)) {
      score += 4;
    }
  }
  if (query.terms.length > 0) {
    const haystack = `${pattern.taskId} ${pattern.taskClass} ${pattern.findings.join(" ")} ${pattern.relatedFiles.join(" ")}`.toLowerCase();
    score += query.terms.filter((term) => haystack.includes(term)).length;
  }
  return score;
}

function patternSignature(input: {
  taskClass: string;
  source: string;
  findings: readonly string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      taskClass: input.taskClass,
      source: input.source,
      findings: input.findings.slice(0, 5)
    }))
    .digest("hex");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}
