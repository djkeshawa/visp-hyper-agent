import { execFile } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileCrossPlatform } from "../src/core/exec.js";
import { readState } from "../src/core/session-manager.js";
import { createToolOnlyPathDir } from "./helpers/tool-path-dir.js";
import { createVispShim } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

async function gitInit(projectPath: string): Promise<void> {
  // execFileCrossPlatform, not execFile: AC007 re-creates a repo while PATH is
  // constrained to the tool-only dir (Windows .cmd wrappers).
  await execFileCrossPlatform("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileCrossPlatform("git", ["add", "."], { cwd: projectPath });
  await execFileCrossPlatform(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
}

/**
 * A git repo with a package.json whose `test` script exits zero. No lockfile, so
 * validation detection maps to `npm run test`.
 */
async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-quick-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node -e 0" } }),
    "utf8"
  );
  await gitInit(projectPath);
  return projectPath;
}

async function stage(projectPath: string, file: string): Promise<void> {
  // Runs after PATH is constrained to the tool-only dir, whose Windows entries
  // are .cmd wrappers — resolvable by execFileCrossPlatform but not execFile.
  await execFileCrossPlatform("git", ["add", file], { cwd: projectPath });
}

/**
 * A PATH directory that exposes git, node, and npm (needed to run the detected
 * `npm run test` validation command) but omits any installed `visp` binary so
 * the kit-less branch is exercised.
 */
async function gitNodeOnlyPath(): Promise<string> {
  // npm shells out via `sh` and resolves `node` itself, so both must be present
  // for the detected `npm run test` validation command to execute.
  return createToolOnlyPathDir(["git", "node", "npm", "sh"], { optional: ["npm", "sh"] });
}

async function pipeline(projectPath: string): Promise<any> {
  const state = await readState(projectPath);
  return state.sessions[state.activeSessionId!]!.pipeline;
}

describe("quick command", () => {
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

  it("AC006a: fabricates a one-task pipeline and prints handoff + action + routing", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser", "--files", "src"]);
    const output = logs.join("\n");

    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).toContain("task: Q001 - fix the parser");
    expect(output).toContain("allowed_files:");
    expect(output).toContain("  - src");
    expect(output).toContain("validation_commands:");
    expect(output).toContain("npm run test");
    expect(output).toContain("BEGIN_VISP_MODEL_ROUTING");

    const state = await pipeline(projectPath);
    expect(state.currentTaskId).toBe("Q001");
    expect(state.syntheticTasks).toHaveLength(1);
    expect(state.syntheticTasks[0].id).toBe("Q001");
    expect(state.syntheticTasks[0].validationCommands).toContain("npm run test");
  });

  it("AC006b: the kit-less evidence loop closes via checkpoint --task Q001", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser", "--files", "src"]);

    // An in-scope change so review has something to inspect.
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await stage(projectPath, "src/feature.ts");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);
    const output = logs.join("\n");

    expect(output).toContain("BEGIN_VISP_CHECKPOINT_RESULT");
    expect(output).toContain("evidence_source: local");
    expect(output).toContain("verify: PASSED");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("pipeline_complete: true");

    const state = await pipeline(projectPath);
    expect(state.currentTaskId).toBeNull();
    expect(state.completed).toContain("Q001");
  });

  it("AC006c: a change outside allowed files fails review and keeps the task", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser", "--files", "src"]);

    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "x.ts"), "export const x = 2;\n", "utf8");
    await stage(projectPath, "lib/x.ts");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);
    const output = logs.join("\n");

    expect(output).toContain("status: FAILED");
    expect(output).toContain("outside allowed files");

    const state = await pipeline(projectPath);
    expect(state.currentTaskId).toBe("Q001");
  });

  it("AC007: prints the run hint when a Visp Kit is detected, and not otherwise", async () => {
    const kitless = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", kitless, "quick", "fix the parser"]);
    expect(logs.join("\n")).not.toContain("this project has a Visp Kit");

    const kitProject = await createRepo();
    await mkdir(join(kitProject, ".visp"), { recursive: true });
    await writeFile(join(kitProject, ".visp", "policy.json"), JSON.stringify({ rules: [] }), "utf8");
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" }
        }
      }
    });
    process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;

    logs = [];
    await runCli(["node", "visp-hyper", "--project", kitProject, "quick", "fix the parser"]);
    expect(logs.join("\n")).toContain("this project has a Visp Kit");
  });

  it("legacy state without syntheticTasks still parses", async () => {
    const projectPath = await createRepo();
    const statePath = join(projectPath, ".visp", "hyper", "state.json");
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        activeSessionId: "vh_legacy",
        sessions: {
          vh_legacy: {
            id: "vh_legacy",
            goal: "legacy",
            tool: "generic",
            projectPath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            phase: "initialized",
            relevantFiles: [],
            pipeline: {
              taskIds: ["T001"],
              currentTaskId: "T001",
              completed: [],
              stepHistory: []
            }
          }
        }
      }),
      "utf8"
    );

    const state = await readState(projectPath);
    expect(state.sessions.vh_legacy!.pipeline!.syntheticTasks).toBeUndefined();
  });
});
