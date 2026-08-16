import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../../src/cli/index.js";
import { createVispShim } from "../../../helpers/visp-shim.js";
import { toolOnlyPath } from "../../../helpers/tool-path.js";

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-start-boundary-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  return projectPath;
}

async function addKitSignal(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
}

describe("direct start Kit authority boundary", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("blocks instead of adopting context when Kit is healthy", async () => {
    const projectPath = await createProject();
    await addKitSignal(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: { id: "T001", title: "First task", status: "ready" }
        }
      }
    });
    process.env.PATH = `${dirname(shim.binary)}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    expect(logs.join("\n")).toContain("reason_code: direct_start_requires_kitless_project");
    await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
    await expect(stat(join(projectPath, ".visp", "hyper"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode).toBe(1);
  });

  it("is inconclusive instead of scanning locally when Kit is configured but unavailable", async () => {
    const projectPath = await createProject();
    await addKitSignal(projectPath);
    process.env.PATH = await toolOnlyPath(["git"]);

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    expect(logs.join("\n")).toContain("status: INCONCLUSIVE");
    expect(logs.join("\n")).toContain("reason_code: binary_not_found");
    await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
    await expect(stat(join(projectPath, ".visp", "hyper"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode).toBe(1);
  });

  it("uses the local scanner only when Kit signals are genuinely absent", async () => {
    const projectPath = await createProject();
    process.env.PATH = await toolOnlyPath(["git"]);

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    const output = logs.join("\n");
    expect(output.match(/BEGIN_VISP_AGENT_HANDOFF/gu)).toHaveLength(1);
    expect(output.match(/END_VISP_AGENT_HANDOFF/gu)).toHaveLength(1);
    expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).not.toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      goal: "implement feature",
      contextSource: "visp-hyper relevance scanner",
      validationCommands: [],
      nextCommand: "visp-hyper next"
    });
    expect(manifest.taskId).toBeUndefined();
    expect(manifest.contextArtifact).toBeUndefined();
    expect(manifest.artifactProvenance).toBeUndefined();
    const state = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    );
    expect(Object.keys(state.sessions)).toHaveLength(1);
    expect(state.sessions[state.activeSessionId]).toMatchObject({
      goal: "implement feature",
      phase: "implementation"
    });
    expect(state.sessions[state.activeSessionId].pipeline).toBeUndefined();
    expect((await readdir(join(projectPath, ".visp", "hyper", "current"))).sort()).toEqual([
      "agent-instructions.md",
      "context-manifest.json",
      "context-pack.md",
      "handoff.json",
      "memory-pack.md",
      "quality-gates.md",
      "session.md"
    ]);
    expect(process.exitCode).toBeFalsy();
  });
});
