import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
import {
  CANONICAL_ACTION_RESOURCE_URI,
  canonicalKitSpec,
  createCanonicalProject,
  healthyStatusFixture,
  integrationContractFixture,
  snapshotProject,
  tasklessWorkflowActionV3Fixture,
  workflowActionV2Fixture,
  workflowActionV32Fixture,
  workflowActionV3Fixture
} from "./helpers/canonical-action-fixture.js";
import { toolOnlyPath } from "./helpers/tool-path.js";
import { createVispShim } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distIndex = join(packageRoot, "dist", "index.js");
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  process.exitCode = undefined;
});

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

function hyperActionEnvelope(
  verdict: "ready" | "blocked" | "inconclusive",
  overrides: Record<string, unknown> = {}
) {
  return {
    frameVersion: "1.0",
    authority: "kit",
    action: {
      normalizationVersion: "1.0",
      verdict,
      nextCommand: "visp next",
      ...overrides
    }
  };
}

function hyperActionFrame(
  verdict: "ready" | "blocked" | "inconclusive",
  overrides: Record<string, unknown> = {}
): string {
  return [
    "BEGIN_VISP_HYPER_ACTION_V1",
    JSON.stringify(hyperActionEnvelope(verdict, overrides)),
    "END_VISP_HYPER_ACTION_V1"
  ].join("\n");
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
    const status = response.result.tools.find((tool) => tool.name === "visp_status");

    expect(status?.outputSchema?.properties).toHaveProperty("status");
    expect(status?.outputSchema?.properties).toHaveProperty("frames");
    expect(status?.outputSchema?.properties).toHaveProperty("resourceUris");
  });

  it("tools/list keeps direct-entry, checkpoint, and remembrance authority explicit", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-authority-wording-"));
    const response = (await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    })) as { result: { tools: Array<{ name: string; description: string }> } };
    const descriptions = new Map(response.result.tools.map((tool) => [tool.name, tool.description]));

    expect(descriptions.get("visp_save")).toContain("does not authorize strict Kit progression");
    expect(descriptions.get("visp_learn")).toContain("never a direct write");
    expect(descriptions.get("visp_check")).toContain("without changing any workflow state");
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
      params: { name: "visp_status", arguments: {} }
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
    expect(response.result.structuredContent).toMatchObject({
      tool: "visp_status",
      isError: false
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

    it("AC002: maps a status-less inconclusive checkpoint frame to INCONCLUSIVE", async () => {
      const text = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "verdict: INCONCLUSIVE",
        "reason: authoritative validation is unavailable",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n");
      const response = await callStructuredTool(text, false, 22);

      expect.soft(response.result.isError).toBe(false);
      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
      expect.soft(response.result.structuredContent.text).toBe(text);
      expect.soft(response.result.structuredContent.frames).toEqual([
        { name: "VISP_CHECKPOINT_RESULT", boundary: "begin" },
        { name: "VISP_CHECKPOINT_RESULT", boundary: "end" }
      ]);
    });

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

    it.each(["ready", "blocked", "inconclusive"] as const)(
      "P1_07C2: a successful deprecated WorkflowAction V2 %s frame is marker-only INCONCLUSIVE",
      async (verdict) => {
        const text = [
          "BEGIN_VISP_WORKFLOW_ACTION_V2",
          JSON.stringify({ protocolVersion: "2.0", verdict, nextCommand: "visp context T001" }),
          "END_VISP_WORKFLOW_ACTION_V2"
        ].join("\n");
        const response = await callStructuredTool(text, false, 27);

        expect.soft(response.result.isError).toBe(false);
        expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
        expect.soft(response.result.content).toEqual([{ type: "text", text }]);
        expect.soft(response.result.structuredContent.text).toBe(text);
        expect.soft(response.result.structuredContent.frames).toEqual([
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]);
      }
    );

    it.each(["ready", "blocked", "inconclusive"] as const)(
      "P1_07C2: a failed deprecated WorkflowAction V2 %s frame preserves transport ERROR",
      async (verdict) => {
        const text = [
          "BEGIN_VISP_WORKFLOW_ACTION_V2",
          JSON.stringify({ protocolVersion: "2.0", verdict }),
          "END_VISP_WORKFLOW_ACTION_V2"
        ].join("\n");
        const response = await callStructuredTool(text, true, 75);

        expect.soft(response.result.isError).toBe(true);
        expect.soft(response.result.structuredContent.status).toBe("ERROR");
        expect.soft(response.result.structuredContent.frames).toEqual([
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]);
      }
    );

    it.each([
      [false, "INCONCLUSIVE"],
      [true, "ERROR"]
    ] as const)(
      "P1_07C2: deprecated frame bodies do not turn status text into authority (isError=%s)",
      async (isError, expectedStatus) => {
        const text = [
          "BEGIN_VISP_WORKFLOW_ACTION_V2",
          "status: OK",
          "END_VISP_WORKFLOW_ACTION_V2"
        ].join("\n");
        const response = await callStructuredTool(text, isError, 76);

        expect.soft(response.result.structuredContent.status).toBe(expectedStatus);
      }
    );

    it.each([
      {
        name: "trailing content around a status-like body",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2 trailing",
          "status: OK",
          "END_VISP_WORKFLOW_ACTION_V2 trailing"
        ].join("\n"),
        frames: [
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]
      },
      {
        name: "punctuated delimiters around a status-like body",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2:",
          "status: OK",
          "END_VISP_WORKFLOW_ACTION_V2!"
        ].join("\n"),
        frames: [
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]
      },
      {
        name: "an unmatched begin delimiter",
        text: ["BEGIN_VISP_WORKFLOW_ACTION_V2 trailing", "status: OK"].join("\n"),
        frames: [{ name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" }]
      },
      {
        name: "an unmatched end delimiter",
        text: ["status: OK", "END_VISP_WORKFLOW_ACTION_V2 trailing"].join("\n"),
        frames: [{ name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }]
      },
      {
        name: "a canonical action nested in malformed deprecated delimiters",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2 trailing",
          hyperActionFrame("ready"),
          "END_VISP_WORKFLOW_ACTION_V2 trailing"
        ].join("\n"),
        frames: [
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "end" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]
      },
      {
        name: "a malformed deprecated delimiter mixed with a canonical action",
        text: [hyperActionFrame("ready"), "END_VISP_WORKFLOW_ACTION_V2 trailing"].join("\n"),
        frames: [
          { name: "VISP_HYPER_ACTION_V1", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "end" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]
      },
      {
        name: "canonical markers nested in exact deprecated delimiters",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2",
          hyperActionFrame("ready"),
          "END_VISP_WORKFLOW_ACTION_V2"
        ].join("\n"),
        frames: [
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "end" },
          { name: "VISP_WORKFLOW_ACTION_V2", boundary: "end" }
        ]
      }
    ])(
      "P1_07C2: $name fails closed for both transport outcomes",
      async ({ text, frames }) => {
        for (const [index, isError] of [false, true].entries()) {
          const response = await callStructuredTool(text, isError, 77 + index);

          expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
          expect.soft(response.result.structuredContent.frames).toEqual(frames);
        }
      }
    );

    it.each([
      {
        name: "contiguous prefixes around both deprecated tokens",
        text: [
          "xBEGIN_VISP_WORKFLOW_ACTION_V2",
          "status: OK",
          "xEND_VISP_WORKFLOW_ACTION_V2"
        ].join("\n")
      },
      {
        name: "contiguous suffixes around both deprecated tokens",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2x",
          "status: BLOCKED",
          "END_VISP_WORKFLOW_ACTION_V2x"
        ].join("\n")
      },
      {
        name: "underscore prefixes and suffixes around deprecated tokens",
        text: [
          "prefix_BEGIN_VISP_WORKFLOW_ACTION_V2_suffix",
          "status: OK",
          "prefix_END_VISP_WORKFLOW_ACTION_V2_suffix"
        ].join("\n")
      },
      {
        name: "same-line concatenated deprecated begin and end tokens",
        text: [
          "BEGIN_VISP_WORKFLOW_ACTION_V2END_VISP_WORKFLOW_ACTION_V2",
          "status: OK"
        ].join("\n")
      },
      {
        name: "canonical ready content inside prefixed deprecated tokens",
        text: [
          "xBEGIN_VISP_WORKFLOW_ACTION_V2",
          hyperActionFrame("ready"),
          "xEND_VISP_WORKFLOW_ACTION_V2"
        ].join("\n")
      },
      {
        name: "canonical ready content followed by a suffixed deprecated token",
        text: [hyperActionFrame("ready"), "xEND_VISP_WORKFLOW_ACTION_V2x"].join("\n")
      }
    ])(
      "P1_07C2: $name is contradictory for both transport outcomes",
      async ({ text }) => {
        for (const [index, isError] of [false, true].entries()) {
          const response = await callStructuredTool(text, isError, 79 + index);

          expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
        }
      }
    );

    it.each([
      [false, "OK"],
      [true, "INCONCLUSIVE"]
    ] as const)(
      "P1_07C2: an incomplete near-token remains unrelated (isError=%s)",
      async (isError, expectedStatus) => {
        const text = [
          "xBEGIN_VISP_WORKFLOW_ACTION_V",
          "status: OK",
          "xEND_VISP_WORKFLOW_ACTION_V"
        ].join("\n");
        const response = await callStructuredTool(text, isError, 81);

        expect.soft(response.result.structuredContent.status).toBe(expectedStatus);
      }
    );

    it.each([
      ["ready", "OK"],
      ["blocked", "BLOCKED"],
      ["inconclusive", "INCONCLUSIVE"]
    ] as const)(
      "AC003: maps a framed canonical %s action to %s",
      async (verdict, expectedStatus) => {
        const text = hyperActionFrame(verdict);
        const response = await callStructuredTool(text, false, 60);

        expect.soft(response.result.structuredContent.status).toBe(expectedStatus);
        expect.soft(response.result.structuredContent.frames).toEqual([
          { name: "VISP_HYPER_ACTION_V1", boundary: "begin" },
          { name: "VISP_HYPER_ACTION_V1", boundary: "end" }
        ]);
        expect.soft(response.result.structuredContent.text).toBe(text);
      }
    );

    it.each([
      ["ready", "OK"],
      ["blocked", "BLOCKED"],
      ["inconclusive", "INCONCLUSIVE"]
    ] as const)(
      "AC003: maps a standalone canonical %s resume envelope to %s",
      async (verdict, expectedStatus) => {
        const text = JSON.stringify(hyperActionEnvelope(verdict), null, 2);
        const response = await callStructuredTool(text, false, 61);

        expect.soft(response.result.structuredContent.status).toBe(expectedStatus);
        expect.soft(response.result.structuredContent.frames).toEqual([]);
      }
    );

    it.each([
      ["wrong frame version", { ...hyperActionEnvelope("ready"), frameVersion: "2.0" }],
      ["wrong authority", { ...hyperActionEnvelope("ready"), authority: "hyper" }],
      ["missing action", { frameVersion: "1.0", authority: "kit" }],
      ["unknown verdict", hyperActionEnvelope("ready", { verdict: "passed" })],
      ["leaked wire", hyperActionEnvelope("ready", { wire: { protocolVersion: "3.0" } })]
    ])("AC003: maps a %s envelope to INCONCLUSIVE", async (_name, envelope) => {
      const response = await callStructuredTool(JSON.stringify(envelope), false, 62);

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it("AC003: rejects mixed canonical and legacy action frames", async () => {
      const legacy = [
        "BEGIN_VISP_WORKFLOW_ACTION_V2",
        JSON.stringify({ protocolVersion: "2.0", verdict: "ready" }),
        "END_VISP_WORKFLOW_ACTION_V2"
      ].join("\n");
      const response = await callStructuredTool(
        [hyperActionFrame("ready"), legacy].join("\n"),
        false,
        63
      );

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it("AC003: rejects duplicate canonical action frames", async () => {
      const response = await callStructuredTool(
        [hyperActionFrame("ready"), hyperActionFrame("ready")].join("\n"),
        false,
        69
      );

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it("AC003: rejects malformed framed canonical JSON", async () => {
      const response = await callStructuredTool(
        [
          "BEGIN_VISP_HYPER_ACTION_V1",
          '{"frameVersion":"1.0",',
          "END_VISP_HYPER_ACTION_V1"
        ].join("\n"),
        false,
        70
      );

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it.each(["BLOCKED", "FAILED"] as const)(
      "AC003: a coherent %s command result overrides ready action context",
      async (status) => {
        const response = await callStructuredTool(
          [hyperActionFrame("ready"), `status: ${status}`].join("\n"),
          false,
          64
        );

        expect.soft(response.result.structuredContent.status).toBe(status);
      }
    );

    it("AC003: a coherent success result overrides blocked action readiness", async () => {
      const response = await callStructuredTool(
        [hyperActionFrame("blocked"), "status: OK"].join("\n"),
        false,
        65
      );

      expect.soft(response.result.structuredContent.status).toBe("OK");
    });

    it("AC003: checkpoint evidence remains PASSED when its next action is blocked", async () => {
      const checkpoint = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "verdict: PASSED",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n");
      const response = await callStructuredTool(
        [checkpoint, hyperActionFrame("blocked")].join("\n"),
        false,
        67
      );

      expect.soft(response.result.structuredContent.status).toBe("PASSED");
    });

    it("AC003: unrelated standalone JSON preserves transport ERROR", async () => {
      const response = await callStructuredTool(
        JSON.stringify({ message: "transport failed" }),
        true,
        66
      );

      expect.soft(response.result.structuredContent.status).toBe("ERROR");
    });

    it("AC003: unrelated transport authority JSON preserves ERROR", async () => {
      const response = await callStructuredTool(
        JSON.stringify({ authority: "proxy", message: "transport failed" }),
        true,
        71
      );

      expect.soft(response.result.structuredContent.status).toBe("ERROR");
    });

    it("AC003: unrelated truncated normalization JSON preserves ERROR", async () => {
      const response = await callStructuredTool(
        '{"normalizationVersion":"1.0"',
        true,
        73
      );

      expect.soft(response.result.structuredContent.status).toBe("ERROR");
    });

    it("AC003: a truncated claimed action envelope is INCONCLUSIVE", async () => {
      const response = await callStructuredTool(
        '{"frameVersion":"1.0","authority":"kit"',
        true,
        68
      );

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it("AC003: a ready action from a failed execution is INCONCLUSIVE", async () => {
      const response = await callStructuredTool(hyperActionFrame("ready"), true, 72);

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
    });

    it.each([
      ["explicit OK", "status: OK"],
      [
        "checkpoint PASSED",
        [
          "BEGIN_VISP_CHECKPOINT_RESULT",
          "verdict: PASSED",
          "END_VISP_CHECKPOINT_RESULT"
        ].join("\n")
      ]
    ])("AC003: failed execution plus %s is INCONCLUSIVE", async (_name, text) => {
      const response = await callStructuredTool(text, true, 74);

      expect.soft(response.result.structuredContent.status).toBe("INCONCLUSIVE");
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
});

function prependVispShim(binary: string): void {
  process.env.PATH = `${dirname(binary)}${delimiter}${originalPath ?? ""}`;
}

async function readCanonicalActionResource(projectPath: string, id = 1) {
  const response = (await handleMessage(createToolContext(projectPath), {
    jsonrpc: "2.0",
    id,
    method: "resources/read",
    params: { uri: CANONICAL_ACTION_RESOURCE_URI }
  })) as { result: { contents: Array<{ uri: string; mimeType: string; text: string }> } };
  const content = response.result.contents[0]!;
  return { content, body: JSON.parse(content.text) as Record<string, unknown> };
}

describe("handleMessage resources and prompts surface", () => {
  it("advertises one exact computed canonical-action resource and hashes it into the stable surface manifest", async () => {
    const projectPath = await createCanonicalProject();
    const action = workflowActionV3Fixture();
    const shim = await createVispShim(canonicalKitSpec({ action }));
    prependVispShim(shim.binary);
    const before = await snapshotProject(projectPath);
    const ctx = createToolContext(projectPath);

    const listed = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list"
    })) as { result: { resources: Array<Record<string, unknown>> } };
    const canonical = listed.result.resources.filter(
      (resource) => resource.uri === CANONICAL_ACTION_RESOURCE_URI
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({
      uri: CANONICAL_ACTION_RESOURCE_URI,
      name: "canonical-action.json",
      title: "Current Canonical Action",
      mimeType: "application/json",
      annotations: { audience: ["user", "assistant"], priority: 1 }
    });
    // The advertised resource must stay documented in a file that ships, so the
    // MCP surface cannot drift away from its documentation unnoticed. This moved
    // out of the README when the reference material moved into docs/.
    expect(await readFile(join(packageRoot, "docs/mcp.md"), "utf8")).toContain(
      `- \`${CANONICAL_ACTION_RESOURCE_URI}\``
    );

    const first = await readCanonicalActionResource(projectPath, 2);
    const second = await readCanonicalActionResource(projectPath, 3);
    expect(first.content).toMatchObject({
      uri: CANONICAL_ACTION_RESOURCE_URI,
      mimeType: "application/json"
    });
    expect(first.content.text.endsWith("\n")).toBe(true);
    expect(first.content.text).toBe(`${JSON.stringify(first.body, null, 2)}\n`);
    expect(first.content.text).toBe(second.content.text);
    expect(first.body).toEqual({
      resourceVersion: "1.0",
      availability: "available",
      envelope: expect.objectContaining({
        frameVersion: "1.0",
        authority: "kit",
        action: expect.objectContaining({ verdict: "ready" })
      })
    });
    expect(Object.keys(first.body)).toEqual(["resourceVersion", "availability", "envelope"]);
    expect((first.body.envelope as { action: Record<string, unknown> }).action).not.toHaveProperty("wire");
    expect(
      (await readFile(shim.argvLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    ).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"],
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"]
    ]);

    const manifestReads = await Promise.all([4, 5].map(async (id) => {
      const response = (await handleMessage(ctx, {
        jsonrpc: "2.0",
        id,
        method: "resources/read",
        params: { uri: "visp-hyper://meta/surface-manifest" }
      })) as { result: { contents: Array<{ text: string }> } };
      return JSON.parse(response.result.contents[0]!.text) as {
        surfaceHash: string;
        resources: Array<Record<string, unknown>>;
      };
    }));
    expect(manifestReads[0].surfaceHash).toBe(manifestReads[1].surfaceHash);
    expect(
      manifestReads[0].resources.filter((resource) => resource.uri === CANONICAL_ACTION_RESOURCE_URI)
    ).toEqual([
      expect.objectContaining({
        uri: CANONICAL_ACTION_RESOURCE_URI,
        name: "canonical-action.json",
        title: "Current Canonical Action",
        mimeType: "application/json",
        annotations: { audience: ["user", "assistant"], priority: 1 },
        computed: true
      })
    ]);
    expect(await snapshotProject(projectPath)).toEqual(before);
  });

  it("exposes the exact Kit-authored WorkflowAction 3.2 assurance summary", async () => {
    const projectPath = await createCanonicalProject();
    const action = workflowActionV32Fixture();
    const contract = integrationContractFixture({
      protocols: ["2.0", "3.0", "3.1", "3.2"]
    });
    const shim = await createVispShim(canonicalKitSpec({ action, contract }));
    prependVispShim(shim.binary);

    const { body } = await readCanonicalActionResource(projectPath);
    const publicAction = (body.envelope as { action: Record<string, unknown> }).action;
    expect(publicAction.assuranceSummary).toEqual(action.assuranceSummary);
    expect(publicAction.verdict).toBe(action.verdict);
    expect(publicAction.nextCommand).toBe(action.nextCommand);
    expect(publicAction).not.toHaveProperty("wire");
    expect(
      (await readFile(shim.argvLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
    ).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.2", "--json"]
    ]);
  });

  it.each([
    ["ready", false],
    ["blocked", false],
    ["inconclusive", false],
    ["ready", true],
    ["blocked", true],
    ["inconclusive", true]
  ] as const)("keeps coherent %s taskless=%s actions available", async (verdict, taskless) => {
    const projectPath = await createCanonicalProject();
    const action = taskless
      ? tasklessWorkflowActionV3Fixture(verdict)
      : workflowActionV3Fixture({
          verdict,
          findings: verdict === "ready" ? [] : [{
            code: `VISP.TEST.${verdict.toUpperCase()}`,
            source: "workflow",
            severity: verdict === "blocked" ? "error" : "warning",
            effect: verdict === "blocked" ? "blocks" : "uncertain",
            message: `${verdict} fixture.`,
            recommendation: "Follow the exact Kit command.",
            evidence: []
          }]
        });
    const activeTask = taskless ? null : undefined;
    const shim = await createVispShim(canonicalKitSpec({
      action,
      actionExitCode: verdict === "ready" ? 0 : 1,
      status: healthyStatusFixture(activeTask),
      contract: integrationContractFixture({ activeTask })
    }));
    prependVispShim(shim.binary);

    const { body } = await readCanonicalActionResource(projectPath);
    expect(body).toMatchObject({
      resourceVersion: "1.0",
      availability: "available",
      envelope: {
        frameVersion: "1.0",
        authority: "kit",
        action: { verdict, task: taskless ? null : expect.objectContaining({ id: "T001" }) }
      }
    });
    expect(body).not.toHaveProperty("reasonCode");
  });

  it.each([
    {
      label: "advertised v2",
      contract: integrationContractFixture({ protocols: ["2.0"] }),
      selectionMode: "advertised"
    },
    {
      label: "selector-less legacy v2",
      contract: integrationContractFixture({ protocols: null }),
      selectionMode: "legacy_v2"
    }
  ])("exposes honest $label normalization without private wire", async ({ contract, selectionMode }) => {
    const projectPath = await createCanonicalProject();
    const shim = await createVispShim(canonicalKitSpec({
      action: workflowActionV2Fixture({
        writablePaths: ["src\\feature.ts", "src\\path with spaces.ts"]
      }),
      contract
    }));
    prependVispShim(shim.binary);

    const { body } = await readCanonicalActionResource(projectPath);
    expect(body).toMatchObject({
      availability: "available",
      envelope: {
        action: {
          source: { protocolVersion: "2.0", selectionMode },
          sourceCanonicalVersion: { state: "unavailable", reasonCode: "not_in_protocol" },
          actionId: { state: "unavailable", reasonCode: "not_in_protocol" },
          scope: { writablePaths: ["src/feature.ts", "src/path with spaces.ts"] }
        }
      }
    });
    expect((body.envelope as { action: object }).action).not.toHaveProperty("wire");
  });

  it("returns the closed unavailable union for genuine Kit absence without writes or local enrichment", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-canonical-kitless-"));
    await writeFile(join(projectPath, "README.md"), "# Kit-less\n", "utf8");
    const before = await snapshotProject(projectPath);

    const first = await readCanonicalActionResource(projectPath, 1);
    const second = await readCanonicalActionResource(projectPath, 2);
    expect(first.body).toEqual({
      resourceVersion: "1.0",
      availability: "unavailable",
      authority: "none",
      reasonCode: "no_kit_signals",
      reason: expect.any(String)
    });
    expect(Object.keys(first.body)).toEqual([
      "resourceVersion",
      "availability",
      "authority",
      "reasonCode",
      "reason"
    ]);
    expect(first.content.text).toBe(second.content.text);
    expect(first.content.text).not.toContain("kit_strict");
    expect(first.body).not.toHaveProperty("envelope");
    expect(await snapshotProject(projectPath)).toEqual(before);
  });

  it("returns configured-unhealthy as Kit-authority inconclusive without writes", async () => {
    const projectPath = await createCanonicalProject();
    const before = await snapshotProject(projectPath);
    process.env.PATH = await toolOnlyPath(["git"]);

    const { body } = await readCanonicalActionResource(projectPath);
    expect(body).toEqual({
      resourceVersion: "1.0",
      availability: "inconclusive",
      authority: "kit",
      reasonCode: "binary_not_found",
      reason: expect.any(String)
    });
    expect(body).not.toHaveProperty("envelope");
    expect(await snapshotProject(projectPath)).toEqual(before);
  });

  it.each([
    {
      label: "future-only advertisement",
      contract: integrationContractFixture({
        overrides: {
          protocols: {
            workflowAction: {
              supported: ["4.0"],
              default: "4.0",
              schemaHashes: { "4.0": `sha256:${"a".repeat(64)}` }
            }
          }
        }
      }),
      action: workflowActionV3Fixture(),
      expectedReason: "workflow_action_no_mutual_protocol"
    },
    {
      label: "malformed advertisement",
      contract: integrationContractFixture({
        overrides: {
          protocols: {
            workflowAction: {
              supported: ["2.0"],
              default: "3.0",
              schemaHashes: { "2.0": `sha256:${"a".repeat(64)}` }
            }
          }
        }
      }),
      action: workflowActionV3Fixture(),
      expectedReason: "workflow_action_advertisement_invalid"
    },
    {
      label: "malformed integration contract",
      contract: "not-json",
      action: workflowActionV3Fixture(),
      expectedReason: "integration_contract_unavailable"
    },
    {
      label: "selected hash mismatch",
      contract: integrationContractFixture({
        overrides: {
          protocols: {
            workflowAction: {
              supported: ["3.0"],
              default: "3.0",
              schemaHashes: { "3.0": `sha256:${"0".repeat(64)}` }
            }
          }
        }
      }),
      action: workflowActionV3Fixture(),
      expectedReason: "workflow_action_schema_hash_mismatch"
    },
    {
      label: "wrong selected protocol",
      contract: integrationContractFixture({ protocols: ["3.0"] }),
      action: workflowActionV2Fixture(),
      expectedReason: "workflow_action_protocol_mismatch"
    },
    {
      label: "malformed action JSON",
      contract: integrationContractFixture(),
      action: "not-json",
      expectedReason: "workflow_action_schema_invalid"
    },
    {
      label: "extra action field",
      contract: integrationContractFixture(),
      action: { ...workflowActionV3Fixture(), unexpected: true },
      expectedReason: "workflow_action_schema_invalid"
    },
    {
      label: "missing action field",
      contract: integrationContractFixture(),
      action: (() => {
        const { nextCommand: _nextCommand, ...missing } = workflowActionV3Fixture();
        return missing;
      })(),
      expectedReason: "workflow_action_schema_invalid"
    },
    {
      label: "invalid v3 identity",
      contract: integrationContractFixture(),
      action: { ...workflowActionV3Fixture(), actionId: `sha256:${"0".repeat(64)}` },
      expectedReason: "workflow_action_identity_invalid"
    },
    {
      label: "semantic contradiction",
      contract: integrationContractFixture(),
      action: workflowActionV3Fixture({
        requiredReads: [
          {
            id: "duplicate",
            role: "policy",
            path: ".visp/policy.json",
            contentHash: `sha256:${"1".repeat(64)}`,
            freshness: "content_hash"
          },
          {
            id: "duplicate",
            role: "context_pack",
            path: ".visp/context.json",
            contentHash: `sha256:${"2".repeat(64)}`,
            freshness: "content_hash"
          }
        ]
      }),
      expectedReason: "workflow_action_semantics_invalid"
    },
    {
      label: "ready action from nonzero process",
      contract: integrationContractFixture(),
      action: workflowActionV3Fixture(),
      actionExitCode: 1,
      expectedReason: "workflow_action_contradiction"
    }
  ])("fails closed for $label with a stable diagnostic and no envelope", async ({
    contract,
    action,
    actionExitCode,
    expectedReason
  }) => {
    const projectPath = await createCanonicalProject();
    const shim = await createVispShim(canonicalKitSpec({ action, contract, actionExitCode }));
    prependVispShim(shim.binary);

    const { body, content } = await readCanonicalActionResource(projectPath);
    expect(body).toEqual({
      resourceVersion: "1.0",
      availability: "inconclusive",
      authority: "kit",
      reasonCode: expectedReason,
      reason: expect.any(String)
    });
    expect(String(body.reason)).not.toMatch(/[\r\n]/u);
    expect(body).not.toHaveProperty("envelope");
  });
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
            contractVersion: "2.0",
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
      contractVersion: "2.0",
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
    expect(manifest.tools.map((tool: { name: string }) => tool.name)).toContain("visp_save");
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
    expect(prompt.result.messages[0]?.content.text).toContain("visp_work");
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
  });

  it("a failing verb reports isError and restores console + exit code", async () => {
    const projectPath = await createRepo();

    const originalLog = console.log;
    const ctx = createToolContext(projectPath);
    // No Kit is installed in this bare repo, so visp_new refuses visibly.
    const result = await ctx.execute("visp_new", { goal: "add a thing" });

    expect(result.isError).toBe(true);
    // The message now names ONE actionable command instead of offering two.
    expect(result.text).toMatch(/visp setup|visp-kit init/u);
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
    const first = ctx.execute("visp_doctor", { json: true });
    const second = ctxB.execute("visp_doctor", { json: true });
    const [a, b] = await Promise.all([first, second]);

    // Each capture is one complete JSON document. Interleaved captures would
    // not parse.
    expect(() => JSON.parse(a.text) as unknown).not.toThrow();
    expect(() => JSON.parse(b.text) as unknown).not.toThrow();
  });

  it("visp_new without a goal is rejected without side effects", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-noargs-"));
    const ctx = createToolContext(projectPath);
    const result = await ctx.execute("visp_new", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid arguments");
    expect(await fileExists(join(projectPath, ".visp"))).toBe(false);
  });

  it("AC006: the bridge advertises exactly the thirteen visp_* verbs (D-106)", async () => {
    const tools = await createMcpBridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "visp_setup",
      "visp_doctor",
      "visp_new",
      "visp_plan",
      "visp_next",
      "visp_work",
      "visp_check",
      "visp_save",
      "visp_handoff",
      "visp_status",
      "visp_recall",
      "visp_learn",
      "visp_cockpit"
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
    send({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "visp_status", arguments: {} } });

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
    expect(callResponse.result.content[0].text.length).toBeGreaterThan(0);

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
