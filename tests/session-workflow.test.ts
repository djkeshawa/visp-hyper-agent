import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { initializeProject } from "../src/core/session-manager.js";

const requiredCurrentFiles = [
  "session.md",
  "context-pack.md",
  "memory-pack.md",
  "quality-gates.md",
  "agent-instructions.md",
  "handoff.json"
];

describe("local session workflow", () => {
  afterEach(() => {
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

    expect(stdout).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(stdout).toContain("completion_instruction:");
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
      ".visp/hyper/current/memory-pack.md",
      ".visp/hyper/current/quality-gates.md",
      ".visp/hyper/current/agent-instructions.md"
    ]);
  });
});
