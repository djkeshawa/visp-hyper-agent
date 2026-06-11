import { basename } from "node:path";
import { z } from "zod";
import type {
  DecisionRecord,
  MemoryRecord,
  MemoryResult,
  ProjectMemoryProfile,
  RecallOptions,
  SemanticMemoryProvider
} from "../core/types.js";

const DEFAULT_ENDPOINT = "http://localhost:8000";
const DEFAULT_TIMEOUT_MS = 3000;
const SUMMARY_MAX = 220;

/** Tolerant schema for a single memory object — parse only the fields we consume. */
const memorySchema = z
  .object({
    id: z.string(),
    content: z.string(),
    category: z.string().optional(),
    similarity: z.number().nullable().optional(),
    relevance_score: z.number().nullable().optional()
  })
  .passthrough();

const memoryArraySchema = z.array(memorySchema);

type MemoryObject = z.infer<typeof memorySchema>;

/**
 * Derive a stable repo id from the project path: the lowercased directory name
 * with spaces collapsed to hyphens.
 */
export function repoIdForProject(projectPath: string): string {
  return basename(projectPath).toLowerCase().replace(/\s+/gu, "-");
}

interface LlmMemoryInput {
  endpoint: string;
  projectPath: string;
  timeoutMs?: number;
  apiKey?: string;
}

export class LlmMemoryProvider implements SemanticMemoryProvider {
  readonly warnings: string[] = [];

  private readonly endpoint: string;
  private readonly repoId: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(input: LlmMemoryInput) {
    this.endpoint = (input.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/u, "");
    this.repoId = repoIdForProject(input.projectPath);
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiKey = input.apiKey ?? process.env.VISP_HYPER_MEMORY_API_KEY;
  }

  async recall(query: string, options: RecallOptions = {}): Promise<MemoryResult[]> {
    const detailed = await this.recallDetailed(query, options);
    return detailed.map((entry) => entry.result);
  }

  async recallDetailed(
    query: string,
    options: RecallOptions = {}
  ): Promise<Array<{ result: MemoryResult; score: number | null; category: string }>> {
    return this.runRecall(query, options);
  }

  async semanticRecall(query: string, options: RecallOptions = {}): Promise<MemoryResult[]> {
    const minScore = parseMinScore(options.filters?.minScore);
    const detailed = await this.runRecall(query, options, minScore);
    return detailed.map((entry) => entry.result);
  }

  async remember(record: MemoryRecord): Promise<void> {
    const metadata = pruneUndefined({
      sessionId: record.sessionId,
      goal: record.goal,
      changedFiles: record.changedFiles,
      reviewSummary: record.reviewSummary,
      decisions: record.decisions,
      followUps: record.followUps
    });
    await this.post("/memories", {
      content: record.summary,
      layer: "episodic",
      category: "session",
      repo_id: this.repoId,
      source: "visp-hyper",
      metadata
    });
  }

  async storeDecision(decision: DecisionRecord): Promise<void> {
    await this.post("/memories", {
      content: `${decision.title}: ${decision.decision}`,
      layer: "episodic",
      category: "architecture_decision",
      repo_id: this.repoId,
      source: "visp-hyper"
    });
  }

  async getProjectProfile(projectPath: string): Promise<ProjectMemoryProfile | null> {
    const url = `${this.endpoint}/memories?repo_id=${encodeURIComponent(this.repoId)}&limit=20`;
    const parsed = await this.request(url, { method: "GET" }, memoryArraySchema);
    if (!parsed || parsed.length === 0) {
      return null;
    }
    const summary = parsed
      .slice(0, 5)
      .map((item) => `- ${summarize(item.content)}`)
      .join("\n");
    return { projectPath, summary };
  }

  private async runRecall(
    query: string,
    options: RecallOptions,
    minScore?: number
  ): Promise<Array<{ result: MemoryResult; score: number | null; category: string }>> {
    const body: Record<string, unknown> = {
      query,
      layers: ["episodic", "semantic", "intent"],
      repo_id: this.repoId,
      limit: options.limit ?? 10
    };
    if (minScore !== undefined) {
      body.min_score = minScore;
    }
    const parsed = await this.request(
      `${this.endpoint}/recall`,
      { method: "POST", body: JSON.stringify(body) },
      memoryArraySchema
    );
    if (!parsed) {
      return [];
    }
    return parsed
      .map((item) => ({
        result: toMemoryResult(item),
        score: scoreOf(item),
        category: item.category ?? ""
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  private async post(path: string, body: Record<string, unknown>): Promise<void> {
    await this.request(
      `${this.endpoint}${path}`,
      { method: "POST", body: JSON.stringify(body) },
      memorySchema
    );
  }

  private async request<T>(
    url: string,
    init: { method: string; body?: string },
    schema: z.ZodType<T>
  ): Promise<T | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers["X-API-KEY"] = this.apiKey;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      this.warnings.push(`llm-memory request to ${url} failed: ${reason(error)}`);
      return null;
    }
    if (!response.ok) {
      this.warnings.push(`llm-memory request to ${url} returned ${response.status}.`);
      return null;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      this.warnings.push(`llm-memory response from ${url} was not valid JSON: ${reason(error)}`);
      return null;
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      this.warnings.push(`llm-memory response from ${url} did not match the expected schema.`);
      return null;
    }
    return result.data;
  }
}

function toMemoryResult(item: MemoryObject): MemoryResult {
  return {
    path: `llm-memory://${item.id}`,
    content: item.content,
    summary: summarize(item.content)
  };
}

function scoreOf(item: MemoryObject): number | null {
  return item.relevance_score ?? item.similarity ?? null;
}

function summarize(content: string): string {
  const firstText = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstText ? firstText.slice(0, SUMMARY_MAX) : "No summary content.";
}

function parseMinScore(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function pruneUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
