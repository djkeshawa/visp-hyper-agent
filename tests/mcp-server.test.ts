import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileCrossPlatform } from "../src/core/exec.js";
import { initializeProject } from "../src/core/session-manager.js";
import {
  handleMessage,
  type JsonRpcMessage,
  type McpContext
} from "../src/mcp/mcp-server.js";
import { createMcpBridge, createToolContext } from "../src/mcp/tool-bridge.js";

const execFileAsync = promisify(execFile);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distIndex = join(packageRoot, "dist", "index.js");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stubContext(executeImpl?: McpContext["execute"]): McpContext {
  return {
    tools: [
      { name: "alpha", description: "Alpha tool", inputSchema: { type: "object", properties: {} } },
      { name: "beta", description: "Beta tool", inputSchema: { type: "object", properties: {} } }
    ],
    execute:
      executeImpl ??
      (async (name, args) => ({ text: `ran ${name} with ${JSON.stringify(args)}`, isError: false })),
    serverInfo: { name: "visp-hyper", version: "0.1.0" }
  };
}

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
}

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await gitInit(projectPath);
  return projectPath;
}

/** Active quick-style session with a single synthetic task (no on-disk graph). */
async function writeQuickSession(
  projectPath: string,
  task: { id: string; allowedFiles?: string[] }
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260612_mcp00001";
  const state = {
    activeSessionId: sessionId,
    sessions: {
      [sessionId]: {
        id: sessionId,
        goal: "quick task",
        tool: "codex",
        projectPath,
        createdAt: now,
        updatedAt: now,
        phase: "implementation",
        relevantFiles: [],
        pipeline: {
          taskIds: [task.id],
          currentTaskId: task.id,
          completed: [],
          stepHistory: [],
          syntheticTasks: [{ id: task.id, dependsOn: [], allowedFiles: task.allowedFiles }]
        }
      }
    }
  };
  await writeFile(
    join(projectPath, ".visp", "hyper", "state.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

describe("handleMessage protocol core (AC001)", () => {
  it("initialize echoes a custom protocolVersion and reports serverInfo", async () => {
    const ctx = stubContext();
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    })) as { result: { protocolVersion: string; capabilities: object; serverInfo: object } };
    expect(response.result.protocolVersion).toBe("2024-11-05");
    expect(response.result.capabilities).toEqual({ tools: {} });
    expect(response.result.serverInfo).toEqual(ctx.serverInfo);
  });

  it("initialize applies a default protocolVersion when absent", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    })) as { result: { protocolVersion: string } };
    expect(response.result.protocolVersion).toBe("2025-06-18");
  });

  it("initialize advertises resources and prompts when the context supports them", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-capabilities-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    })) as { result: { capabilities: Record<string, object> } };

    expect(response.result.capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {}
    });
  });

  it("notifications/initialized yields no response", async () => {
    const response = await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(response).toBeNull();
  });

  it("ping returns an empty result", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 7,
      method: "ping"
    })) as { result: object };
    expect(response.result).toEqual({});
  });

  it("an unknown method with an id is method-not-found", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list"
    })) as { error: { code: number } };
    expect(response.error.code).toBe(-32601);
  });

  it("an unknown notification yields no response", async () => {
    const response = await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      method: "notifications/cancelled"
    });
    expect(response).toBeNull();
  });

  it("a request missing a method but carrying an id is invalid", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 3
    })) as { error: { code: number } };
    expect(response.error.code).toBe(-32600);
  });
});

describe("handleMessage tools surface (AC003)", () => {
  it("tools/list returns the context's tool table", async () => {
    const ctx = stubContext();
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as { result: { tools: object[] } };
    expect(response.result.tools).toEqual(ctx.tools);
  });

  it("tools/list advertises output schemas for Hyper tools", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-output-schema-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as { result: { tools: Array<{ name: string; outputSchema?: { properties?: Record<string, unknown> } }> } };
    const report = response.result.tools.find((tool) => tool.name === "hyper_report");

    expect(report?.outputSchema?.properties).toHaveProperty("status");
    expect(report?.outputSchema?.properties).toHaveProperty("frames");
    expect(report?.outputSchema?.properties).toHaveProperty("resourceUris");
  });

  it("tools/call routes name+arguments to execute and wraps the result", async () => {
    const calls: Array<{ name: string; args: object }> = [];
    const ctx = stubContext(async (name, args) => {
      calls.push({ name, args });
      return { text: "captured output", isError: false };
    });
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "alpha", arguments: { goal: "x" } }
    })) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(calls).toEqual([{ name: "alpha", args: { goal: "x" } }]);
    expect(response.result.content).toEqual([{ type: "text", text: "captured output" }]);
    expect(response.result.isError).toBe(false);
  });

  it("tools/call returns structuredContent when a Hyper tool declares an output schema", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-structured-output-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "hyper_report", arguments: { json: false } }
    })) as {
      result: {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
        structuredContent: {
          tool: string;
          isError: boolean;
          status: string;
          frames: Array<{ name: string; boundary: string }>;
          text: string;
        };
      };
    };

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("VISP_HYPER_REPORT");
    expect(response.result.structuredContent).toMatchObject({
      tool: "hyper_report",
      isError: false,
      status: "OK"
    });
    expect(response.result.structuredContent.frames).toContainEqual({
      name: "VISP_HYPER_REPORT",
      boundary: "begin"
    });
    expect(response.result.structuredContent.text).toBe(response.result.content[0]?.text);
  });

  it("tools/call for an unknown tool is an invalid-params error and does not execute", async () => {
    let executed = false;
    const ctx = stubContext(async () => {
      executed = true;
      return { text: "", isError: false };
    });
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "missing", arguments: {} }
    })) as { error: { code: number; message: string } };
    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("Unknown tool: missing");
    expect(executed).toBe(false);
  });
});

describe("handleMessage resources and prompts surface", () => {
  it("resources/list and resources/read expose generated Visp Hyper artifacts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-resources-"));
    await initializeProject(projectPath);
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-pack.md"),
      "# Context\n\n- src/feature.ts\n",
      "utf8"
    );
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
      "{\"version\":\"0.1\",\"sessionId\":\"vh_test\"}\n",
      "utf8"
    );
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "checkpoint-snapshot.json"),
      "{\"version\":\"0.1\",\"surface\":\"checkpoint\"}\n",
      "utf8"
    );
    const ctx = createToolContext(projectPath);

    const listed = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list"
    })) as { result: { resources: Array<{ uri: string; name: string }> } };
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://meta/surface-manifest"
    );
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://current/context-freshness"
    );
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://current/kit-read-contract"
    );
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://current/context-pack"
    );
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://current/context-manifest"
    );
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(
      "visp-hyper://current/checkpoint-snapshot"
    );

    const read = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "visp-hyper://current/context-pack" }
    })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    expect(read.result.contents[0]).toMatchObject({
      uri: "visp-hyper://current/context-pack",
      mimeType: "text/markdown",
      text: "# Context\n\n- src/feature.ts\n"
    });

    const manifestRead = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "visp-hyper://current/context-manifest" }
    })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    expect(manifestRead.result.contents[0]).toMatchObject({
      uri: "visp-hyper://current/context-manifest",
      mimeType: "application/json",
      text: "{\"version\":\"0.1\",\"sessionId\":\"vh_test\"}\n"
    });

    const freshnessRead = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 6,
      method: "resources/read",
      params: { uri: "visp-hyper://current/context-freshness" }
    })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    const freshness = JSON.parse(freshnessRead.result.contents[0]?.text ?? "{}");
    expect(freshnessRead.result.contents[0]).toMatchObject({
      uri: "visp-hyper://current/context-freshness",
      mimeType: "application/json"
    });
    expect(freshness).toMatchObject({
      version: "0.1",
      status: "untracked",
      blocking: false,
      warnings: []
    });
    expect(freshness.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

    const kitReadContractRead = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/read",
      params: { uri: "visp-hyper://current/kit-read-contract" }
    })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    const kitReadContract = JSON.parse(kitReadContractRead.result.contents[0]?.text ?? "{}");
    expect(kitReadContractRead.result.contents[0]).toMatchObject({
      uri: "visp-hyper://current/kit-read-contract",
      mimeType: "application/json"
    });
    expect(kitReadContract).toMatchObject({
      version: "0.1",
      status: "unavailable"
    });
    expect(kitReadContract.reason).toContain("no Kit read contract");

    const snapshotRead = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "visp-hyper://current/checkpoint-snapshot" }
    })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
    expect(snapshotRead.result.contents[0]).toMatchObject({
      uri: "visp-hyper://current/checkpoint-snapshot",
      mimeType: "application/json",
      text: "{\"version\":\"0.1\",\"surface\":\"checkpoint\"}\n"
    });
  });

  it("context freshness resource reports stale pinned context", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-context-freshness-"));
    await initializeProject(projectPath);
    const originalContext = "# Context\n\n- src/feature.ts\n";
    const changedContext = "# Context\n\n- src/other.ts\n";
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-pack.md"),
      originalContext,
      "utf8"
    );
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
      `${JSON.stringify(
        {
          version: "0.1",
          sessionId: "vh_test",
          contextArtifact: {
            path: ".visp/hyper/current/context-pack.md",
            hash: sha256(originalContext),
            hashAlgorithm: "sha256"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-pack.md"),
      changedContext,
      "utf8"
    );

    const read = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "visp-hyper://current/context-freshness" }
    })) as { result: { contents: Array<{ mimeType: string; text: string }> } };
    const freshness = JSON.parse(read.result.contents[0]?.text ?? "{}");

    expect(read.result.contents[0]?.mimeType).toBe("application/json");
    expect(freshness).toMatchObject({
      status: "stale",
      blocking: true,
      artifactPath: ".visp/hyper/current/context-pack.md",
      expectedHash: sha256(originalContext),
      actualHash: sha256(changedContext)
    });
    expect(freshness.finding).toContain("context artifact changed since handoff");
  });

  it("kit read contract resource returns adopted Kit artifact roles when present", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-kit-read-contract-"));
    await initializeProject(projectPath);
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
      `${JSON.stringify(
        {
          version: "0.1",
          sessionId: "vh_test",
          kitReadContract: {
            contractVersion: "1.3",
            readContractVersion: "0.1",
            requiredArtifacts: [
              {
                id: "context-pack",
                path: ".visp/features/001-x/context/T009.context.json",
                role: "context-pack",
                mimeType: "application/json",
                requiredFor: ["handoff", "implementation", "checkpoint"],
                freshness: "hash-pinned"
              }
            ],
            freshnessPolicy: {
              contextPackHashPinned: true,
              provenanceArtifactsHashPinned: true,
              staleContextBlocks: ["implementation", "checkpoint", "pr"]
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const read = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "visp-hyper://current/kit-read-contract" }
    })) as { result: { contents: Array<{ mimeType: string; text: string }> } };
    const contract = JSON.parse(read.result.contents[0]?.text ?? "{}");

    expect(read.result.contents[0]?.mimeType).toBe("application/json");
    expect(contract).toMatchObject({
      version: "0.1",
      status: "available",
      contractVersion: "1.3",
      readContractVersion: "0.1",
      freshnessPolicy: {
        contextPackHashPinned: true,
        provenanceArtifactsHashPinned: true,
        staleContextBlocks: ["implementation", "checkpoint", "pr"]
      }
    });
    expect(contract.requiredArtifacts).toContainEqual(
      expect.objectContaining({
        id: "context-pack",
        role: "context-pack",
        freshness: "hash-pinned"
      })
    );
  });

  it("surface manifest hashes the advertised MCP tools, resources, prompts, and safety posture", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-surface-"));
    const ctx = createToolContext(projectPath);

    const read = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "visp-hyper://meta/surface-manifest" }
    })) as { result: { contents: Array<{ mimeType: string; text: string }> } };
    const manifest = JSON.parse(read.result.contents[0]?.text ?? "{}");

    expect(read.result.contents[0]?.mimeType).toBe("application/json");
    expect(manifest.surfaceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.capabilities.dynamicToolRegistration).toBe(false);
    expect(manifest.safetyPosture.noLlmCalls).toBe(true);
    expect(manifest.safetyPosture.structuredToolResults).toContain("structuredContent");
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toContain("hyper_checkpoint");
    expect(
      manifest.tools.every(
        (tool: { inputSchemaHash?: string; outputSchemaHash?: string }) =>
          /^[a-f0-9]{64}$/u.test(tool.inputSchemaHash ?? "") &&
          /^[a-f0-9]{64}$/u.test(tool.outputSchemaHash ?? "")
      )
    ).toBe(true);
    expect(manifest.resources.map((resource: { uri: string }) => resource.uri)).toContain(
      "visp-hyper://current/checkpoint-snapshot"
    );
    expect(manifest.resources.map((resource: { uri: string }) => resource.uri)).toContain(
      "visp-hyper://current/context-freshness"
    );
    expect(manifest.resources.map((resource: { uri: string }) => resource.uri)).toContain(
      "visp-hyper://current/kit-read-contract"
    );
    expect(
      manifest.resources.find(
        (resource: { uri: string; computed?: boolean }) =>
          resource.uri === "visp-hyper://current/context-freshness"
      )?.computed
    ).toBe(true);
    expect(
      manifest.resources.find(
        (resource: { uri: string; computed?: boolean }) =>
          resource.uri === "visp-hyper://current/kit-read-contract"
      )?.computed
    ).toBe(true);
    expect(manifest.prompts.map((prompt: { name: string }) => prompt.name)).toEqual([
      "hyper_resume",
      "hyper_run_goal"
    ]);
  });

  it("resources/read rejects unknown resources", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-missing-resource-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "visp-hyper://current/missing" }
    })) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("Unknown resource");
  });

  it("prompts/list and prompts/get expose safe workflow prompts", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-prompts-"));
    const ctx = createToolContext(projectPath);

    const listed = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/list"
    })) as { result: { prompts: Array<{ name: string }> } };
    expect(listed.result.prompts.map((prompt) => prompt.name)).toEqual([
      "hyper_resume",
      "hyper_run_goal"
    ]);

    const prompt = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "prompts/get",
      params: { name: "hyper_run_goal", arguments: { goal: "ship the audit trail" } }
    })) as { result: { messages: Array<{ content: { text: string } }> } };
    expect(prompt.result.messages[0]?.content.text).toContain("hyper_run");
    expect(prompt.result.messages[0]?.content.text).toContain("ship the audit trail");
  });
});

describe("tool bridge execution", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("hyper_guard blocks an out-of-scope staged file and restores console + exit code", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await execFileAsync("git", ["add", "lib/rogue.ts"], { cwd: projectPath });

    const originalLog = console.log;
    const ctx = createToolContext(projectPath);
    const result = await ctx.execute("hyper_guard", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("status: BLOCKED");
    expect(result.text).toContain("lib/rogue.ts");
    // console.log is restored and the host exit code is not left dirtied.
    expect(console.log).toBe(originalLog);
    expect(process.exitCode).toBeFalsy();
  });

  it("AC004: concurrent executions do not interleave their captured output", async () => {
    const projectA = await createRepo();
    const projectB = await createRepo();
    const ctx = createToolContext(projectA);
    const ctxB = createToolContext(projectB);

    // Fire without awaiting the first; the serialization queue is shared.
    const first = ctx.execute("hyper_report", {});
    const second = ctxB.execute("hyper_report", {});
    const [a, b] = await Promise.all([first, second]);

    const countFrames = (text: string): number =>
      (text.match(/VISP_HYPER_REPORT/g) ?? []).length;
    // Each result contains exactly one report's begin+end markers (2 matches),
    // proving the two captures never bled into one another.
    expect(countFrames(a.text)).toBe(2);
    expect(countFrames(b.text)).toBe(2);
    expect(a.text).toContain("END_VISP_HYPER_REPORT");
    expect(b.text).toContain("END_VISP_HYPER_REPORT");
  });

  it("hyper_quick without a goal is rejected without side effects", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-noargs-"));
    const ctx = createToolContext(projectPath);
    const result = await ctx.execute("hyper_quick", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid arguments");
    expect(await fileExists(join(projectPath, ".visp"))).toBe(false);
  });

  it("AC006: the bridge advertises the hyper tools", async () => {
    const tools = await createMcpBridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "hyper_quick",
      "hyper_run",
      "hyper_next",
      "hyper_resume",
      "hyper_status",
      "hyper_doctor",
      "hyper_checkpoint",
      "hyper_guard",
      "hyper_review",
      "hyper_remember",
      "hyper_report"
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});

describe("serve --mcp stdio integration (AC002/AC005)", () => {
  beforeAll(async () => {
    const built = (await fileExists(distIndex))
      ? (await readFile(distIndex, "utf8")).includes('"serve"')
      : false;
    if (!built) {
      await execFileCrossPlatform("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
    }
  }, 320_000);

  it("answers an MCP session over stdio and exits 0 when stdin closes", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-serve-"));

    const child = spawn("node", [distIndex, "serve", "--mcp", "--project", projectPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutLines: string[] = [];
    let buffer = "";
    const callId = 100;

    const callArrived = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for tools/call response")), 20_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.length === 0) {
            continue;
          }
          stdoutLines.push(line);
          const parsed = JSON.parse(line) as { id?: number };
          if (parsed.id === callId) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.stdout.on("error", reject);
    });

    const send = (msg: JsonRpcMessage): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "hyper_report", arguments: {} } });

    await callArrived;

    // Every emitted stdout line is valid JSON-RPC 2.0.
    const parsedLines = stdoutLines.map((line) => JSON.parse(line) as { jsonrpc?: string; id?: number });
    for (const message of parsedLines) {
      expect(message.jsonrpc).toBe("2.0");
    }

    const callResponse = parsedLines.find((message) => message.id === callId) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(callResponse.result.isError).toBe(false);
    expect(callResponse.result.content[0].text).toContain("VISP_HYPER_REPORT");

    // notifications/initialized produced no addressed response (no id:null lines
    // and no extra error frames beyond the three request ids).
    const ids = parsedLines.map((message) => message.id).sort((a, b) => Number(a) - Number(b));
    expect(ids).toEqual([1, 2, callId]);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
      child.stdin.end();
    });
    expect(exitCode).toBe(0);
  }, 30_000);
});
