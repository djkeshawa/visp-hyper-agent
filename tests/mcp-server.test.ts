import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCliCommand } from "../src/cli/index.js";
import { execFileCrossPlatform } from "../src/core/exec.js";
import { initializeProject } from "../src/core/session-manager.js";
import {
  handleMessage,
  MCP_PROTOCOL_VERSION,
  runStdioServer,
  type JsonRpcMessage,
  type McpContext
} from "../src/mcp/mcp-server.js";
import { createMcpBridge, createToolContext } from "../src/mcp/tool-bridge.js";
import { initialPipelineState } from "../src/pipeline/pipeline-engine.js";

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

type StructuredToolCallResponse = {
  jsonrpc: string;
  id: number;
  result: {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    structuredContent: {
      tool: string;
      isError: boolean;
      status: string;
      frames: Array<{ name: string; boundary: "begin" | "end" }>;
      resourceUris: string[];
      text: string;
    };
  };
};

async function callStructuredTool(
  text: string,
  isError = false,
  id = 2
): Promise<StructuredToolCallResponse> {
  const ctx = stubContext(async () => ({ text, isError }));
  ctx.tools = [{ ...ctx.tools[0]!, outputSchema: { type: "object" } }];
  return (await handleMessage(ctx, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "alpha", arguments: {} }
  })) as StructuredToolCallResponse;
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
  const syntheticTask = {
    id: task.id,
    title: "Quick task",
    description: "Quick task",
    dependsOn: [],
    allowedFiles: task.allowedFiles,
    status: "pending" as const,
    riskLevel: "low" as const
  };
  const pipeline = initialPipelineState(
    { tasks: [syntheticTask] },
    { kind: "synthetic", source: `quick:${sessionId}` }
  );
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
        pipeline: { ...pipeline, syntheticTasks: [syntheticTask] }
      }
    }
  };
  await writeFile(
    join(projectPath, ".visp", "hyper", "state.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

describe("handleMessage protocol core (AC001/AC005)", () => {
  it("initialize negotiates an unsupported protocolVersion and reports serverInfo", async () => {
    const ctx = stubContext();
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05" }
    })) as { result: { protocolVersion: string; capabilities: object; serverInfo: object } };
    expect(response.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(response.result.capabilities).toEqual({ tools: {} });
    expect(response.result.serverInfo).toEqual(ctx.serverInfo);
  });

  it("initialize applies a default protocolVersion when absent", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    })) as { result: { protocolVersion: string } };
    expect(response.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it("initialize rejects a non-string protocolVersion", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 20250618 }
    })) as { error: { code: number } };
    expect(response.error.code).toBe(-32602);
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

  it("a request method without an id is treated as a notification and not executed", async () => {
    let executed = false;
    const response = await handleMessage(
      stubContext(async () => {
        executed = true;
        return { text: "unexpected", isError: false };
      }),
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "alpha", arguments: {} }
      }
    );
    expect(response).toBeNull();
    expect(executed).toBe(false);
  });

  it("a request missing a method but carrying an id is invalid", async () => {
    const response = (await handleMessage(stubContext(), {
      jsonrpc: "2.0",
      id: 3
    })) as { error: { code: number } };
    expect(response.error.code).toBe(-32600);
  });

  it.each([
    null,
    "request",
    7,
    [],
    {},
    { jsonrpc: "1.0", id: 4, method: "ping" },
    { jsonrpc: "2.0", id: { unsafe: true }, method: "ping" },
    { jsonrpc: "2.0", id: 1.5, method: "ping" },
    { jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, method: "ping" },
    { jsonrpc: "2.0", id: 5, method: 42 }
  ])("rejects an invalid JSON-RPC envelope without throwing: %j", async (message) => {
    const response = (await handleMessage(stubContext(), message)) as {
      jsonrpc: string;
      error: { code: number };
    };
    expect(response.jsonrpc).toBe("2.0");
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

  it("tools/list advertises the strict checkpoint and guard argument contract", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-input-schema-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: { additionalProperties?: boolean; properties?: Record<string, unknown> };
        }>;
      };
    };
    const checkpoint = response.result.tools.find((tool) => tool.name === "hyper_checkpoint");
    const guard = response.result.tools.find((tool) => tool.name === "hyper_guard");

    expect(checkpoint?.inputSchema.additionalProperties).toBe(false);
    expect(checkpoint?.inputSchema.properties).toHaveProperty("allowEmpty");
    expect(guard?.inputSchema.additionalProperties).toBe(false);
    expect(guard?.inputSchema.properties).toMatchObject({
      feature: expect.objectContaining({ minLength: 1 }),
      task: expect.objectContaining({ minLength: 1 })
    });
  });

  it("tools/list keeps direct-entry, checkpoint, and remembrance authority explicit", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-authority-wording-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as { result: { tools: Array<{ name: string; description: string }> } };
    const descriptions = new Map(response.result.tools.map((tool) => [tool.name, tool.description]));

    expect(descriptions.get("hyper_quick")).toContain("genuinely Kit-less");
    expect(descriptions.get("hyper_checkpoint")).toContain("does not authorize strict Kit progression");
    expect(descriptions.get("hyper_remember")).toContain("does not complete a Kit task");
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

  describe("structured MCP domain status (H02C)", () => {
    it.each([
      [
        "policy",
        [
          "BEGIN_VISP_POLICY_BLOCKED",
          "reason: policy validation denied implementation",
          "resource: visp-hyper://current/policy",
          "END_VISP_POLICY_BLOCKED"
        ].join("\n"),
        "VISP_POLICY_BLOCKED",
        "visp-hyper://current/policy"
      ],
      [
        "pipeline",
        [
          "BEGIN_VISP_PIPELINE_BLOCKED",
          "reason: no authoritative task is ready",
          "resource: visp-hyper://current/pipeline",
          "END_VISP_PIPELINE_BLOCKED"
        ].join("\n"),
        "VISP_PIPELINE_BLOCKED",
        "visp-hyper://current/pipeline"
      ]
    ])(
      "AC001: maps a status-less %s blocked frame to BLOCKED",
      async (_kind, text, frameName, resourceUri) => {
        const response = await callStructuredTool(text, false, 21);

        expect.soft(response).toMatchObject({
          jsonrpc: "2.0",
          id: 21,
          result: {
            isError: false,
            structuredContent: {
              tool: "alpha",
              isError: false,
              status: "BLOCKED",
              text
            }
          }
        });
        expect.soft(response.result.content).toEqual([{ type: "text", text }]);
        expect.soft(response.result.structuredContent.frames).toEqual([
          { name: frameName, boundary: "begin" },
          { name: frameName, boundary: "end" }
        ]);
        expect.soft(response.result.structuredContent.resourceUris).toEqual([resourceUri]);
      }
    );

    it.each([
      [
        "workflow action",
        [
          "BEGIN_VISP_WORKFLOW_ACTION_V2",
          JSON.stringify({ protocolVersion: "2.0", verdict: "INCONCLUSIVE", nextCommand: "visp status" }),
          "END_VISP_WORKFLOW_ACTION_V2"
        ].join("\n"),
        "VISP_WORKFLOW_ACTION_V2"
      ],
      [
        "checkpoint validation",
        [
          "BEGIN_VISP_CHECKPOINT_RESULT",
          "verdict: INCONCLUSIVE",
          "reason: authoritative validation is unavailable",
          "END_VISP_CHECKPOINT_RESULT"
        ].join("\n"),
        "VISP_CHECKPOINT_RESULT"
      ]
    ])(
      "AC002: maps a status-less inconclusive %s frame to INCONCLUSIVE",
      async (_kind, text, frameName) => {
        const response = await callStructuredTool(text, false, 22);

        expect.soft(response.result.isError).toBe(false);
        expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
        expect.soft(response.result.structuredContent.text).toBe(text);
        expect.soft(response.result.structuredContent.frames).toEqual([
          { name: frameName, boundary: "begin" },
          { name: frameName, boundary: "end" }
        ]);
      }
    );

    it("AC003: maps unknown status-less successful output to INCONCLUSIVE", async () => {
      const text = "captured output with no Visp domain signal";
      const response = await callStructuredTool(text, false, 23);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
      expect.soft(response.result.structuredContent.status).not.toBe("OK");
      expect.soft(response.result.structuredContent.text).toBe(text);
    });

    it.each([
      ["conflicting explicit statuses", "status: PASSED\nstatus: BLOCKED"],
      [
        "a passing status inside a blocked frame",
        [
          "BEGIN_VISP_POLICY_BLOCKED",
          "status: PASSED",
          "reason: policy still blocks the action",
          "END_VISP_POLICY_BLOCKED"
        ].join("\n")
      ]
    ])("AC004: maps %s to INCONCLUSIVE", async (_kind, text) => {
      const response = await callStructuredTool(text, false, 24);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
      expect.soft(response.result.structuredContent.text).toBe(text);
    });

    it("AC005: preserves a coherent explicit status, frames, URI, text, and JSON-RPC shape", async () => {
      const text = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "status: PASSED",
        "resource: visp-hyper://current/checkpoint-snapshot",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n");

      expect(await callStructuredTool(text, false, 25)).toEqual({
        jsonrpc: "2.0",
        id: 25,
        result: {
          content: [{ type: "text", text }],
          isError: false,
          structuredContent: {
            tool: "alpha",
            isError: false,
            status: "PASSED",
            frames: [
              { name: "VISP_CHECKPOINT_RESULT", boundary: "begin" },
              { name: "VISP_CHECKPOINT_RESULT", boundary: "end" }
            ],
            resourceUris: ["visp-hyper://current/checkpoint-snapshot"],
            text
          }
        }
      });
    });

    it("AC005: maps a ready WorkflowAction V2 frame to OK", async () => {
      const text = [
        "BEGIN_VISP_WORKFLOW_ACTION_V2",
        JSON.stringify({ protocolVersion: "2.0", verdict: "ready", nextCommand: "visp context T001" }),
        "END_VISP_WORKFLOW_ACTION_V2"
      ].join("\n");
      const response = await callStructuredTool(text, false, 27);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("OK");
      expect.soft(response.result.content).toEqual([{ type: "text", text }]);
      expect.soft(response.result.structuredContent.text).toBe(text);
      expect.soft(response.result.structuredContent.frames).toEqual([
        { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
        { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
      ]);
    });

    it("maps an unsupported explicit status to INCONCLUSIVE", async () => {
      const response = await callStructuredTool("status: UNKNOWN", false, 28);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it("maps a malformed WorkflowAction V2 frame to INCONCLUSIVE", async () => {
      const text = [
        "BEGIN_VISP_WORKFLOW_ACTION_V2",
        "{not valid JSON}",
        "END_VISP_WORKFLOW_ACTION_V2"
      ].join("\n");
      const response = await callStructuredTool(text, false, 29);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
      expect.soft(response.result.structuredContent.text).toBe(text);
    });

    it("AC006: preserves ERROR for a transport failure without domain evidence", async () => {
      const text = "tool process exited before producing Visp domain output";

      expect(await callStructuredTool(text, true, 26)).toEqual({
        jsonrpc: "2.0",
        id: 26,
        result: {
          content: [{ type: "text", text }],
          isError: true,
          structuredContent: {
            tool: "alpha",
            isError: true,
            status: "ERROR",
            frames: [],
            resourceUris: [],
            text
          }
        }
      });
    });
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

  it.each([
    null,
    [],
    "invalid",
    {},
    { name: 7 },
    { name: "alpha", arguments: null },
    { name: "alpha", arguments: [] },
    { name: "alpha", arguments: "invalid" }
  ])("rejects malformed tool params without executing: %j", async (params) => {
    let executed = false;
    const response = (await handleMessage(
      stubContext(async () => {
        executed = true;
        return { text: "unexpected", isError: false };
      }),
      { jsonrpc: "2.0", id: 30, method: "tools/call", params }
    )) as { error: { code: number } };

    expect(response.error.code).toBe(-32602);
    expect(executed).toBe(false);
  });

  it.each([
    ["hyper_run", { goal: "ship", tool: "unsupported" }],
    ["hyper_next", { extra: true }],
    ["hyper_guard", { feature: "013-feature" }],
    ["hyper_guard", { feature: " ", task: "T005" }],
    ["hyper_guard", { mode: "all", base: "main" }],
    ["hyper_remember", { summary: "done", inputTokens: -1 }]
  ])("returns -32602 for invalid %s arguments", async (name, args) => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-invalid-tool-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name, arguments: args }
    })) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("Invalid arguments");
    expect(await fileExists(join(projectPath, ".visp"))).toBe(false);
  });

  it("returns -32603 for an executor failure and still handles the next request", async () => {
    const ctx = stubContext(async () => {
      throw new Error("executor exploded");
    });
    const failed = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 32,
      method: "tools/call",
      params: { name: "alpha", arguments: {} }
    })) as { error: { code: number; message: string } };
    const next = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 33,
      method: "ping"
    })) as { result: object };

    expect(failed.error).toEqual({ code: -32603, message: "Internal error" });
    expect(next.result).toEqual({});
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

    const resumePrompt = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/get",
      params: { name: "hyper_resume", arguments: {} }
    })) as { result: { messages: Array<{ content: { text: string } }> } };
    const resumeText = resumePrompt.result.messages[0]?.content.text ?? "";
    expect(resumeText).toContain("strict progression and remediation require the exact current ready Kit action");
    expect(resumeText).toContain("A Hyper checkpoint is local evidence only");
  });
});

describe("tool bridge execution", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("runs nested Commander validation without process exit and permits a later invocation", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not be called");
    }) as typeof process.exit);

    const invalid = await runCliCommand(
      ["node", "visp-hyper", "run", "goal", "--tool", "unsupported"],
      {
        writeOut: (chunk) => stdout.push(chunk),
        writeErr: (chunk) => stderr.push(chunk)
      }
    );
    const help = await runCliCommand(["node", "visp-hyper", "run", "--help"], {
      writeOut: (chunk) => stdout.push(chunk),
      writeErr: (chunk) => stderr.push(chunk)
    });

    expect(exit).not.toHaveBeenCalled();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.commanderError?.code).toBe("commander.invalidArgument");
    expect(stderr.join("")).toContain("Allowed choices");
    expect(help.exitCode).toBe(0);
    expect(stdout.join("")).toContain("Usage: visp-hyper run");
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

  it("passes a dash-prefixed goal as data instead of Commander control input", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-dash-goal-"));
    const ctx = createToolContext(projectPath);
    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: { name: "hyper_quick", arguments: { goal: "--help" } }
    })) as { result: { content: Array<{ text: string }>; isError: boolean } };
    const next = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 41,
      method: "ping"
    })) as { result: object };

    expect(response.result.isError).toBe(false);
    expect(response.result.content[0]?.text).toContain("--help");
    expect(response.result.content[0]?.text).not.toContain("Usage: visp-hyper quick");
    expect(next.result).toEqual({});
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

describe("stdio request lifecycle (AC005)", () => {
  it("returns protocol errors for malformed input and continues with a valid request", async () => {
    const messages: object[] = [];
    const diagnostics: string[] = [];
    const input = Readable.from([
      "{not-json}\n",
      "null\n",
      `${JSON.stringify({ jsonrpc: "2.0", id: 51, method: "ping" })}\n`
    ]);

    await runStdioServer(stubContext(), {
      input,
      writeMessage: (message) => messages.push(message),
      writeDiagnostic: (message) => diagnostics.push(message)
    });

    expect(messages).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } },
      { jsonrpc: "2.0", id: 51, result: {} }
    ]);
    expect(diagnostics.join("")).toContain("parse error");
  });

  it("waits for in-flight requests after input closes", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = stubContext(async () => {
      markStarted();
      await gate;
      return { text: "drained", isError: false };
    });
    const messages: object[] = [];
    const input = Readable.from([
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: { name: "alpha", arguments: {} }
      })}\n`
    ]);
    let settled = false;
    const server = runStdioServer(ctx, {
      input,
      writeMessage: (message) => messages.push(message),
      writeDiagnostic: () => undefined
    }).then(() => {
      settled = true;
    });

    await started;
    expect(settled).toBe(false);
    expect(messages).toEqual([]);

    release();
    await server;

    expect(settled).toBe(true);
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 52,
        result: {
          content: [{ type: "text", text: "drained" }],
          isError: false
        }
      }
    ]);
  });

  it("handles input errors, drains accepted work, and rejects without an uncaught readline error", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ctx = stubContext(async () => {
      markStarted();
      await gate;
      return { text: "completed before shutdown", isError: false };
    });
    const input = new Readable({ read: () => undefined });
    const messages: object[] = [];
    const server = runStdioServer(ctx, {
      input,
      writeMessage: (message) => messages.push(message),
      writeDiagnostic: () => undefined
    });

    input.push(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: { name: "alpha", arguments: {} }
    })}\n`);
    await started;
    input.destroy(new Error("stdin boom"));
    release();

    await expect(server).rejects.toThrow("stdin boom");
    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: 53,
        result: {
          content: [{ type: "text", text: "completed before shutdown" }],
          isError: false
        }
      }
    ]);
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

    const child = spawn(process.execPath, [distIndex, "serve", "--mcp", "--project", projectPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const stdoutLines: string[] = [];
    let stderr = "";
    let buffer = "";
    const callId = 100;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const callArrived = new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${message}${stderr ? `: ${stderr.trim()}` : ""}`));
      };
      const timer = setTimeout(() => fail("timed out waiting for tools/call response"), 20_000);
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
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.stdout.on("error", (error) => fail(`MCP stdout failed: ${error.message}`));
      child.on("error", (error) => fail(`MCP child failed to start: ${error.message}`));
      child.on("exit", (code, signal) => {
        if (!settled) fail(`MCP child exited before tools/call response (code=${code}, signal=${signal})`);
      });
    });

    const send = (msg: JsonRpcMessage): void => {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "hyper_report", arguments: {} } });

    const exit = new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    // Close immediately after dispatch. The server must drain the tool request
    // and write its response before the process can exit.
    child.stdin.end();

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

    const exitCode = await exit;
    expect(exitCode).toBe(0);
  }, 30_000);
});
