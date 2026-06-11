import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/defaults.js";
import { readConfig } from "../src/core/session-manager.js";
import { LlmMemoryProvider, repoIdForProject } from "../src/memory/llm-memory-provider.js";
import { selectMemoryProvider } from "../src/memory/provider-factory.js";
import { startMockMemoryServer, type MockMemoryServer } from "./helpers/mock-memory-server.js";

let server: MockMemoryServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

const projectPath = "/tmp/My Project";

describe("repoIdForProject", () => {
  it("lowercases the basename and replaces spaces with hyphens", () => {
    expect(repoIdForProject("/tmp/My Project")).toBe("my-project");
    expect(repoIdForProject("/a/b/Visp Hyper Agent")).toBe("visp-hyper-agent");
  });
});

describe("LlmMemoryProvider.recall (AC001)", () => {
  it("posts the correct body and maps a sorted array response with llm-memory:// paths", async () => {
    server = await startMockMemoryServer({
      "POST /recall": {
        json: [
          {
            id: "m1",
            content: "Lower scored memory\nsecond line",
            layer: "episodic",
            category: "session",
            relevance_score: 0.3,
            similarity: 0.9,
            extra_field: "ignored"
          },
          {
            id: "m2",
            content: "Higher scored memory",
            layer: "semantic",
            category: "architecture_decision",
            relevance_score: 0.8
          }
        ]
      }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    const results = await provider.recall("auth flow", { limit: 5 });

    expect(provider.warnings).toEqual([]);
    expect(results.map((r) => r.path)).toEqual(["llm-memory://m2", "llm-memory://m1"]);
    expect(results[0]?.summary).toBe("Higher scored memory");
    expect(results[1]?.summary).toBe("Lower scored memory");

    const recall = server.requests.find((r) => r.path === "/recall");
    expect(recall?.method).toBe("POST");
    expect(recall?.body).toMatchObject({
      query: "auth flow",
      layers: ["episodic", "semantic", "intent"],
      repo_id: "my-project",
      limit: 5
    });
  });

  it("recallDetailed exposes score and category; semanticRecall passes min_score", async () => {
    server = await startMockMemoryServer({
      "POST /recall": {
        json: [{ id: "m1", content: "hello", layer: "episodic", category: "session", similarity: 0.5 }]
      }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    const detailed = await provider.recallDetailed("q");
    expect(detailed[0]?.score).toBe(0.5);
    expect(detailed[0]?.category).toBe("session");
    expect(detailed[0]?.result.path).toBe("llm-memory://m1");

    await provider.semanticRecall("q", { filters: { minScore: "0.7" } });
    const semantic = server.requests.at(-1);
    expect(semantic?.body).toMatchObject({ min_score: 0.7 });
  });
});

describe("LlmMemoryProvider.remember / storeDecision (AC002)", () => {
  it("posts session memory with correct layer/category/metadata and X-API-KEY when provided", async () => {
    server = await startMockMemoryServer({
      "POST /memories": { json: { id: "saved", content: "x", layer: "episodic", category: "session" } }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath, apiKey: "secret-key" });

    await provider.remember({
      sessionId: "vh_1",
      goal: "ship feature",
      summary: "did the work",
      changedFiles: ["a.ts"],
      reviewSummary: undefined
    });

    expect(provider.warnings).toEqual([]);
    const req = server.requests.find((r) => r.path === "/memories");
    expect(req?.headers["x-api-key"]).toBe("secret-key");
    expect(req?.body).toMatchObject({
      content: "did the work",
      layer: "episodic",
      category: "session",
      repo_id: "my-project",
      source: "visp-hyper",
      metadata: { sessionId: "vh_1", goal: "ship feature", changedFiles: ["a.ts"] }
    });
    expect((req?.body as { metadata: Record<string, unknown> }).metadata).not.toHaveProperty("reviewSummary");
  });

  it("posts architecture decisions and omits X-API-KEY when no key is configured", async () => {
    const previous = process.env.VISP_HYPER_MEMORY_API_KEY;
    delete process.env.VISP_HYPER_MEMORY_API_KEY;
    try {
      server = await startMockMemoryServer({
        "POST /memories": { json: { id: "d1", content: "x", layer: "episodic", category: "architecture_decision" } }
      });
      const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

      await provider.storeDecision({ title: "Use zod", decision: "validate all inputs" });

      const req = server.requests.find((r) => r.path === "/memories");
      expect(req?.headers["x-api-key"]).toBeUndefined();
      expect(req?.body).toMatchObject({
        content: "Use zod: validate all inputs",
        layer: "episodic",
        category: "architecture_decision",
        repo_id: "my-project",
        source: "visp-hyper"
      });
    } finally {
      if (previous === undefined) {
        delete process.env.VISP_HYPER_MEMORY_API_KEY;
      } else {
        process.env.VISP_HYPER_MEMORY_API_KEY = previous;
      }
    }
  });

  it("getProjectProfile builds a bulleted summary, null when empty", async () => {
    server = await startMockMemoryServer({
      "GET /memories": (req) =>
        req.path.includes("empty")
          ? { json: [] }
          : { json: [{ id: "a", content: "First", layer: "episodic" }, { id: "b", content: "Second", layer: "episodic" }] }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    const profile = await provider.getProjectProfile(projectPath);
    expect(profile?.summary).toBe("- First\n- Second");
    expect(profile?.projectPath).toBe(projectPath);
  });
});

describe("LlmMemoryProvider degradation (AC003)", () => {
  it("returns empty results and warns on a 500 response", async () => {
    server = await startMockMemoryServer({
      "POST /recall": { status: 500, json: { detail: "boom" } }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    const results = await provider.recall("q");
    expect(results).toEqual([]);
    expect(provider.warnings.length).toBeGreaterThan(0);
  });

  it("returns empty results and warns on garbage JSON", async () => {
    server = await startMockMemoryServer({
      "POST /recall": { raw: "<<< not json >>>" }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    const results = await provider.recall("q");
    expect(results).toEqual([]);
    expect(provider.warnings.length).toBeGreaterThan(0);
  });

  it("does not throw when the connection is refused (closed server)", async () => {
    const closed = await startMockMemoryServer({});
    const url = closed.url;
    await closed.close();
    const provider = new LlmMemoryProvider({ endpoint: url, projectPath, timeoutMs: 500 });

    const results = await provider.recall("q");
    expect(results).toEqual([]);
    await expect(provider.remember({ sessionId: "s", goal: "g", summary: "x" })).resolves.toBeUndefined();
    expect(await provider.getProjectProfile(projectPath)).toBeNull();
    expect(provider.warnings.length).toBeGreaterThan(0);
  });
});

describe("selectMemoryProvider (AC004)", () => {
  it("returns a null provider for file mode without probing", async () => {
    const selection = await selectMemoryProvider({
      config: { ...defaultConfig, memoryMode: "file" },
      projectPath
    });
    expect(selection).toEqual({ provider: null, mode: "file", warnings: [] });
  });

  it("returns an LlmMemoryProvider when healthz is ok", async () => {
    server = await startMockMemoryServer({
      "GET /healthz": { json: { status: "ok", version: "1.0", timestamp: "t" } }
    });
    const selection = await selectMemoryProvider({
      config: { ...defaultConfig, memoryMode: "llm-memory", memoryEndpoint: server.url },
      projectPath
    });
    expect(selection.mode).toBe("llm-memory");
    expect(selection.provider).toBeInstanceOf(LlmMemoryProvider);
    expect(selection.warnings).toEqual([]);
  });

  it("falls back to file with a warning when healthz is down", async () => {
    const closed = await startMockMemoryServer({});
    const url = closed.url;
    await closed.close();
    const selection = await selectMemoryProvider({
      config: { ...defaultConfig, memoryMode: "llm-memory", memoryEndpoint: url },
      projectPath,
      timeoutMs: 500
    });
    expect(selection.provider).toBeNull();
    expect(selection.mode).toBe("file");
    expect(selection.warnings[0]).toMatch(/falling back to file memory/);
  });

  it("falls back when healthz reports a non-ok status", async () => {
    server = await startMockMemoryServer({
      "GET /healthz": { json: { status: "degraded" } }
    });
    const selection = await selectMemoryProvider({
      config: { ...defaultConfig, memoryMode: "llm-memory", memoryEndpoint: server.url },
      projectPath
    });
    expect(selection.provider).toBeNull();
    expect(selection.mode).toBe("file");
    expect(selection.warnings.length).toBe(1);
  });
});

describe("config extension (AC005)", () => {
  it("parses a legacy config without memoryEndpoint and accepts llm-memory mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-cfg-"));
    const hyperDir = join(dir, ".visp", "hyper");
    await mkdir(hyperDir, { recursive: true });
    await writeFile(
      join(hyperDir, "config.json"),
      JSON.stringify({
        defaultTool: "generic",
        tokenBudget: 12000,
        memoryMode: "llm-memory",
        contextMode: "deterministic",
        blockedPaths: []
      }),
      "utf8"
    );

    const config = await readConfig(dir);
    expect(config.memoryMode).toBe("llm-memory");
    expect(config.memoryEndpoint).toBe("http://localhost:8000");
  });

  it("defaults to file mode", () => {
    expect(defaultConfig.memoryMode).toBe("file");
    expect(defaultConfig.memoryEndpoint).toBe("http://localhost:8000");
  });
});
