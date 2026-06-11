import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { collectLocalEvidence } from "../src/quality/local-evidence.js";
import { createVispShim } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";

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
  const projectPath = await mkdtemp(join(tmpdir(), "visp-local-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await gitInit(projectPath);
  return projectPath;
}

async function stage(projectPath: string, file: string): Promise<void> {
  await execFileAsync("git", ["add", file], { cwd: projectPath });
}

/**
 * A PATH directory that exposes git and node (needed by validation commands and
 * the checkpoint's git diff) but deliberately omits any installed `visp` binary
 * so the kit-less branch is exercised.
 */
async function gitNodeOnlyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-nokit-"));
  const { stdout: gitPath } = await execFileAsync("which", ["git"]);
  await symlink(gitPath.trim(), join(dir, "git"));
  await symlink(process.execPath, join(dir, "node"));
  return dir;
}

describe("collectLocalEvidence", () => {
  it("AC001-verify: passing validation command yields verifyPassed", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node --version"] },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(true);
  });

  it("AC001-verify: failing validation command yields a finding", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node -e process.exit(2)"] },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(false);
    expect(evidence.findings.some((line) => line.startsWith("verify failed: node -e process.exit(2) (exit 2)"))).toBe(
      true
    );
  });

  it("vacuous: no commands and no scripts pass verify with a warning", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(true);
    expect(evidence.warnings).toContain("no validation commands detected; verify passed vacuously");
    expect(evidence.findings).toContain("no validation commands detected; verify passed vacuously");
  });

  it("AC003-scope: changed file outside allowed files fails review", async () => {
    const projectPath = await createRepo();
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "other.ts"), "export const x = 2;\n", "utf8");
    await stage(projectPath, "lib/other.ts");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings).toContain("scope violation: lib/other.ts outside allowed files");
  });

  it("AC003-scope: changed file inside allowed files passes review", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(true);
    expect(evidence.findings.some((line) => line.startsWith("scope violation:"))).toBe(false);
  });

  it("AC003-scope: blocked path change fails review", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, ".env"), "SECRET=1\n", "utf8");
    await stage(projectPath, ".env");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: [".env"]
    });
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings).toContain("scope violation: .env is a blocked path");
  });

  it("empty diff: review passes with a no-changes finding", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(true);
    expect(evidence.findings).toContain("no changes detected");
  });
});

describe("checkpoint --task local evidence integration", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  async function writeTaskGraph(projectPath: string, validationCommands: string[]): Promise<void> {
    const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
    await mkdir(featureDir, { recursive: true });
    await writeFile(
      join(featureDir, "task-graph.json"),
      JSON.stringify({
        featureId: "001",
        featureSlug: "pipeline",
        tasks: [
          {
            id: "T001",
            title: "First task",
            description: "Implement the first task",
            dependsOn: [],
            allowedFiles: ["src/feature.ts"],
            validationCommands,
            status: "ready"
          },
          {
            id: "T002",
            title: "Second task",
            dependsOn: ["T001"],
            allowedFiles: ["src/other.ts"]
          }
        ]
      }),
      "utf8"
    );
  }

  async function injectPipeline(projectPath: string): Promise<void> {
    const statePath = join(projectPath, ".visp", "hyper", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const sessionId = state.activeSessionId;
    state.sessions[sessionId].pipeline = {
      taskIds: ["T001", "T002"],
      currentTaskId: "T001",
      completed: [],
      stepHistory: []
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  async function readPipeline(projectPath: string): Promise<any> {
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    return state.sessions[state.activeSessionId].pipeline;
  }

  it("AC001/AC002: passing local evidence advances the pipeline", async () => {
    const projectPath = await createRepo();
    await writeTaskGraph(projectPath, ["node --version"]);

    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath);

    // A real, in-scope change so review has something to inspect.
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: local");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("next_task: T002");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T002");
    expect(pipeline.completed).toContain("T001");
  });

  it("AC001/AC002: failing validation keeps the current task and reports findings", async () => {
    const projectPath = await createRepo();
    await writeTaskGraph(projectPath, ["node -e process.exit(2)"]);

    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: local");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("verify: FAILED");
    expect(output).toContain("findings:");
    expect(output).toContain("verify failed: node -e process.exit(2) (exit 2)");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T001");
    expect(pipeline.completed).not.toContain("T001");
  });

  it("kit-present parity: a working visp shim reports evidence_source: kit", async () => {
    const projectPath = await createRepo();
    await writeTaskGraph(projectPath, ["pnpm typecheck"]);

    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: { id: "T001", title: "First task", status: "ready" }
        }
      },
      verify: { stdout: { success: true } },
      review: { stdout: { success: true } }
    });
    process.env.PATH = `${dirname(shim.binary)}:${originalPath ?? ""}`;

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: kit");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("next_task: T002");
  });
});
