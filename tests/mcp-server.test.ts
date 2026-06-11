import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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

  it("AC006: the bridge advertises the seven hyper tools", async () => {
    const tools = await createMcpBridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "hyper_quick",
      "hyper_run",
      "hyper_next",
      "hyper_checkpoint",
      "hyper_guard",
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
      await execFileAsync("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
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
