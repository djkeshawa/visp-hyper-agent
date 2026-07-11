import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { initCommand } from "../src/cli/commands/init.js";
import { readConfig } from "../src/core/session-manager.js";
import { LlmMemoryProvider, repoIdForProject } from "../src/memory/llm-memory-provider.js";
import { selectMemoryProvider } from "../src/memory/provider-factory.js";
import { defaultConfig } from "../src/core/defaults.js";
import { startMockMemoryServer, type MockMemoryServer } from "./helpers/mock-memory-server.js";

async function createProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "visp-memcfg-"));
}

async function readConfigJson(projectPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(projectPath, ".visp", "hyper", "config.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("init memory configuration flags", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("AC001a: --memory-endpoint sets llm-memory mode and keeps other fields", async () => {
    const projectPath = await createProject();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "init",
      "--memory-endpoint",
      "http://127.0.0.1:9999"
    ]);

    const config = await readConfigJson(projectPath);
    expect(config.memoryMode).toBe("llm-memory");
    expect(config.memoryEndpoint).toBe("http://127.0.0.1:9999");
    expect(config.defaultTool).toBe(defaultConfig.defaultTool);
    expect(config.tokenBudget).toBe(defaultConfig.tokenBudget);
    expect(config.skillMode).toBe(defaultConfig.skillMode);
    expect(config.contextMode).toBe("deterministic");
    expect(logs.join("\n")).toContain(
      "memory: mode=llm-memory endpoint=http://127.0.0.1:9999 repo_id=derived"
    );
  });

  it("AC001b: --memory-repo-id normalizes and preserves prior endpoint/mode", async () => {
    const projectPath = await createProject();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "init",
      "--memory-endpoint",
      "http://127.0.0.1:9999"
    ]);

    logs = [];
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "init",
      "--memory-repo-id",
      "My Project"
    ]);

    const config = await readConfigJson(projectPath);
    expect(config.memoryRepoId).toBe("my-project");
    expect(config.memoryMode).toBe("llm-memory");
    expect(config.memoryEndpoint).toBe("http://127.0.0.1:9999");
    expect(logs.join("\n")).toContain("note: repo id normalized to my-project");
  });

  it("AC001c: --memory-mode file with --memory-endpoint stores endpoint but stays inert", async () => {
    const projectPath = await createProject();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "init",
      "--memory-mode",
      "file",
      "--memory-endpoint",
      "https://x.example"
    ]);

    const config = await readConfigJson(projectPath);
    expect(config.memoryMode).toBe("file");
    expect(config.memoryEndpoint).toBe("https://x.example");
    expect(logs.join("\n")).toContain(
      "note: memory endpoint stored but inert while memoryMode is file."
    );
  });

  it("AC002: rejects a non-http(s) endpoint without writing config", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    const before = await readConfigJson(projectPath);

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "init",
      "--memory-endpoint",
      "ftp://bad"
    ]);

    expect(errors.join("\n")).toContain("error: --memory-endpoint must be an http(s) URL.");
    const after = await readConfigJson(projectPath);
    expect(after).toEqual(before);
  });

  it("AC002: rejects an unknown --memory-mode through the option parser", async () => {
    const command = initCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => {} });

    await expect(
      command.parseAsync(["node", "init", "--memory-mode", "weird"])
    ).rejects.toThrow(/is invalid/);
  });
});

describe("LlmMemoryProvider repoId override (AC003/AC004)", () => {
  let server: MockMemoryServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  const projectPath = "/tmp/My Project";

  it("AC003: uses the explicit repoId in recall and remember bodies", async () => {
    server = await startMockMemoryServer({
      "POST /recall": { json: [] },
      "POST /memories": { json: { id: "x", content: "x", layer: "episodic", category: "session" } }
    });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath, repoId: "team-x" });

    await provider.recall("q");
    await provider.remember({ sessionId: "s", goal: "g", summary: "did work" });

    const recall = server.requests.find((r) => r.path === "/recall");
    expect(recall?.body).toMatchObject({ repo_id: "team-x" });
    const remember = server.requests.find((r) => r.path === "/memories");
    expect(remember?.body).toMatchObject({ repo_id: "team-x" });
  });

  it("AC003: factory passes memoryRepoId through to provider requests", async () => {
    server = await startMockMemoryServer({
      "GET /healthz": { json: { status: "ok" } },
      "POST /recall": { json: [] }
    });
    const selection = await selectMemoryProvider({
      config: { ...defaultConfig, memoryMode: "llm-memory", memoryEndpoint: server.url, memoryRepoId: "team-y" },
      projectPath
    });
    expect(selection.provider).toBeInstanceOf(LlmMemoryProvider);

    await selection.provider?.recall("q");
    const recall = server.requests.find((r) => r.path === "/recall");
    expect(recall?.body).toMatchObject({ repo_id: "team-y" });
  });

  it("AC004: without repoId, derives from project basename", async () => {
    server = await startMockMemoryServer({ "POST /recall": { json: [] } });
    const provider = new LlmMemoryProvider({ endpoint: server.url, projectPath });

    await provider.recall("q");
    const recall = server.requests.find((r) => r.path === "/recall");
    expect(recall?.body).toMatchObject({ repo_id: repoIdForProject(projectPath) });
  });

  it("AC004: legacy config without memoryRepoId still parses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-legacy-"));
    const hyperDir = join(dir, ".visp", "hyper");
    await mkdir(hyperDir, { recursive: true });
    await writeFile(
      join(hyperDir, "config.json"),
      JSON.stringify({
        defaultTool: "generic",
        tokenBudget: 12000,
        memoryMode: "file",
        memoryEndpoint: "http://localhost:8000",
        contextMode: "deterministic",
        blockedPaths: []
      }),
      "utf8"
    );

    const config = await readConfig(dir);
    expect(config.memoryRepoId).toBeUndefined();
    expect(config.memoryMode).toBe("file");
  });

  it("legacy config missing blockedPaths keeps its other hand-edited fields and gets default blockedPaths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-legacy-blocked-"));
    const hyperDir = join(dir, ".visp", "hyper");
    await mkdir(hyperDir, { recursive: true });
    // A hand-edited config with a non-default tokenBudget but no blockedPaths.
    // Before blockedPaths was defaulted, the whole store would be discarded to
    // defaults (losing the custom tokenBudget); it must now parse in place.
    await writeFile(
      join(hyperDir, "config.json"),
      JSON.stringify({
        defaultTool: "codex",
        tokenBudget: 99999,
        memoryMode: "file",
        memoryEndpoint: "http://localhost:8000",
        contextMode: "deterministic"
      }),
      "utf8"
    );

    const config = await readConfig(dir);
    // Hand-edited fields survive.
    expect(config.defaultTool).toBe("codex");
    expect(config.tokenBudget).toBe(99999);
    // Missing field is filled from the default, not the whole file reset.
    expect(config.blockedPaths).toEqual(defaultConfig.blockedPaths);
  });
});
