import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { initializeProject } from "../src/core/session-manager.js";
import { createVispShim } from "./helpers/visp-shim.js";

const originalPath = process.env.PATH;

const requiredCurrentFiles = [
  "session.md",
  "context-pack.md",
  "context-manifest.json",
  "memory-pack.md",
  "quality-gates.md",
  "agent-instructions.md",
  "handoff.json"
];

describe("local session workflow", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("initializes config and state without overwriting config unless forced", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hyper-init-"));

    await initializeProject(projectPath);
    const configPath = join(projectPath, ".visp", "hyper", "config.json");
    const statePath = join(projectPath, ".visp", "hyper", "state.json");
    const customConfig = `${JSON.stringify({
      defaultTool: "codex",
      tokenBudget: 4000,
      memoryMode: "file",
      contextMode: "deterministic",
      blockedPaths: [".git"]
    }, null, 2)}\n`;

    await writeFile(configPath, customConfig, "utf8");
    await initializeProject(projectPath);

    expect(await readFile(configPath, "utf8")).toBe(customConfig);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ activeSessionId: null, sessions: {} });

    await initializeProject(projectPath, true);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ defaultTool: "generic" });
  });

  it("start writes current session files and handoff json matching stdout core fields", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hyper-start-"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });

    await writeFile(join(projectPath, "README.md"), "# Demo\n\nOffline note sync CLI.\n", "utf8");
    await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement offline note sync", "--tool", "codex"]);

    for (const file of requiredCurrentFiles) {
      await expect(readFile(join(projectPath, ".visp", "hyper", "current", file), "utf8")).resolves.toEqual(expect.any(String));
    }

    const stdout = logs.join("\n");
    const handoff = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8"));
    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );

    expect(stdout).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(stdout).toContain("completion_instruction:");
    expect(stdout).toContain("mcp_resources:");
    expect(stdout).toContain("visp-hyper://current/context-manifest");
    expect(stdout).toContain("visp-hyper://current/context-freshness (computed)");
    expect(stdout).toContain("visp-hyper://current/kit-read-contract (computed)");
    expect(stdout).toContain(`session_id: ${handoff.sessionId}`);
    expect(stdout).toContain(`goal: ${handoff.goal}`);
    expect(stdout).toContain(`tool_profile: ${handoff.toolProfile}`);
    expect(handoff).toMatchObject({
      version: "0.1",
      goal: "implement offline note sync",
      phase: "implementation",
      toolProfile: "codex"
    });
    expect(handoff.session).toMatchObject({
      id: handoff.sessionId,
      goal: handoff.goal,
      tool: handoff.toolProfile
    });
    expect(handoff.requiredReads).toEqual([
      ".visp/hyper/current/session.md",
      ".visp/hyper/current/context-pack.md",
      ".visp/hyper/current/context-manifest.json",
      ".visp/hyper/current/memory-pack.md",
      ".visp/hyper/current/quality-gates.md",
      ".visp/hyper/current/agent-instructions.md"
    ]);
    expect(handoff.requiredResources.map((resource: { uri: string }) => resource.uri)).toContain(
      "visp-hyper://current/context-manifest"
    );
    expect(handoff.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/context-freshness",
        source: "computed"
      })
    );
    expect(handoff.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/kit-read-contract",
        source: "computed"
      })
    );
    expect(manifest).toMatchObject({
      version: "0.1",
      sessionId: handoff.sessionId,
      goal: "implement offline note sync",
      toolProfile: "codex",
      contextSource: "visp-hyper relevance scanner",
      nextCommand: "visp-hyper next"
    });
    expect(manifest.requiredReads).toEqual(handoff.requiredReads);
    expect(manifest.requiredResources.map((resource: { uri: string }) => resource.uri)).toContain(
      "visp-hyper://current/context-manifest"
    );
    expect(manifest.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/context-freshness",
        source: "computed"
      })
    );
    expect(manifest.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/kit-read-contract",
        source: "computed"
      })
    );
    expect(manifest.selectedFiles.length).toBeGreaterThan(0);
  });

  it.each([
    {
      name: "healthy",
      status: { success: true, initialized: true, activeFeature: { id: "001", slug: "pipeline" } },
      expectedStatus: "BLOCKED"
    },
    {
      name: "configured-unhealthy",
      status: { success: false, initialized: true },
      expectedStatus: "INCONCLUSIVE"
    }
  ])(
    "start stops before session creation when Kit is $name",
    async ({ status, expectedStatus }) => {
      const projectPath = await mkdtemp(join(tmpdir(), "visp-hyper-start-kit-"));
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
        logs.push(String(message));
      });
      await mkdir(join(projectPath, ".visp"), { recursive: true });
      await writeFile(join(projectPath, ".visp", "policy.json"), JSON.stringify({ rules: [] }), "utf8");
      const shim = await createVispShim({
        status: { stdout: { ...status, targetPath: projectPath } }
      });
      process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;

      await runCli(["node", "visp-hyper", "--project", projectPath, "start", "fix the parser"]);
      const output = logs.join("\n");

      expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(output).toContain(`status: ${expectedStatus}`);
      expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
      await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
      expect(process.exitCode).toBe(1);
    }
  );

  it("remember records learnings without claiming Kit task completion", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hyper-remember-"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
    await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "capture safe learnings"]);

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember"]);

    const output = logs.join("\n");
    expect(output).toContain("Session learnings recorded.");
    expect(output).toContain("No Visp Kit task was completed by this command.");
    expect(output).not.toContain("Session completed.");
  });
});
