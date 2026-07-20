import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { readState, writeState } from "../src/core/session-manager.js";
import { initialPipelineState } from "../src/pipeline/pipeline-engine.js";
import { createVispShim } from "./helpers/visp-shim.js";
import { toolOnlyPath } from "./helpers/tool-path.js";

// Resolve every helper's git/npm call the same way the product does, so bare
// commands still spawn when the test replaces PATH with an isolated tool dir.
const execFileAsync = execFileResolved;

const originalPath = process.env.PATH;

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
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
  await execFileAsync("git", ["add", file], { cwd: projectPath });
}

/**
 * A PATH directory that exposes git, node, and npm (needed to run the detected
 * `npm run test` validation command) but omits any installed `visp` binary so
 * the kit-less branch is exercised.
 */
async function gitNodeOnlyPath(): Promise<string> {
  // npm shells out via `sh` and resolves `node` itself, so both must be present
  // for the detected `npm run test` validation command to execute.
  return toolOnlyPath(["git", "npm", "sh"]);
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
    const hyperState = await readState(projectPath);
    expect(state.currentTaskId).toBe("Q001");
    expect(state.graphIdentity).toMatchObject({ kind: "synthetic" });
    expect(state.graphIdentity.source).toBe(`quick:${hyperState.activeSessionId}`);
    expect(state.taskKeys.Q001).toContain("Q001");
    expect(state.syntheticTasks).toHaveLength(1);
    expect(state.syntheticTasks[0].id).toBe("Q001");
    expect(state.syntheticTasks[0].validationCommands).toContain("npm run test");

    const firstTaskKey = state.taskKeys.Q001;
    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix it again", "--files", "src"]);
    const nextState = await pipeline(projectPath);
    expect(nextState.taskKeys.Q001).not.toBe(firstTaskKey);
  });

  it("rejects a synthetic pipeline copied to a different owning session", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser", "--files", "src"]);

    const state = await readState(projectPath);
    const sessionId = state.activeSessionId!;
    state.sessions[sessionId]!.pipeline!.graphIdentity!.source = "quick:vh_different_owner";
    await writeState(projectPath, state);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    const output = logs.join("\n");
    expect(output).toContain("reason_code: pipeline_state_invalid");
    expect(output).toContain("does not belong to the active session");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
  });

  it("does not write checkpoint results into a session that became active during evidence collection", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser"]);

    const before = await readState(projectPath);
    const originalSessionId = before.activeSessionId!;
    const replacementSessionId = "vh_checkpoint_replacement";
    await writeFile(
      join(projectPath, "switch-session.cjs"),
      [
        'const fs = require("node:fs");',
        'const path = ".visp/hyper/state.json";',
        'const state = JSON.parse(fs.readFileSync(path, "utf8"));',
        "const current = state.sessions[state.activeSessionId];",
        `state.sessions[${JSON.stringify(replacementSessionId)}] = { ...current, id: ${JSON.stringify(replacementSessionId)}, goal: "replacement", pipeline: undefined };`,
        `state.activeSessionId = ${JSON.stringify(replacementSessionId)};`,
        "delete state.activeSessionByBranch;",
        'fs.writeFileSync(path, JSON.stringify(state, null, 2) + "\\n");'
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "node switch-session.cjs" } }),
      "utf8"
    );

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);

    const output = logs.join("\n");
    const after = await readState(projectPath);
    expect(output).toContain("reason_code: checkpoint_session_changed");
    expect(after.activeSessionId).toBe(replacementSessionId);
    expect(after.sessions[replacementSessionId]!.pipeline).toBeUndefined();
    expect(after.sessions[originalSessionId]!.pipeline!.stepHistory).toEqual([]);
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

    const checkpointsPath = join(projectPath, ".visp", "hyper", "current", "checkpoints.md");
    const checkpointBefore = await readFile(checkpointsPath, "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    expect(logs.join("\n")).toContain("BEGIN_VISP_PIPELINE_COMPLETE");
    expect(logs.join("\n")).toContain("status: COMPLETE");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);
    expect(logs.join("\n")).toContain("BEGIN_VISP_PIPELINE_COMPLETE");
    expect(await readFile(checkpointsPath, "utf8")).toBe(checkpointBefore);
  });

  it("keeps a quick pipeline pinned to its synthetic task when a disk plan exists", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await writeFile(join(projectPath, "PLAN.md"), "- [ ] unrelated disk task\n", "utf8");
    await execFileAsync("git", ["add", "PLAN.md"], { cwd: projectPath });
    await execFileAsync(
      "git",
      ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "add plan"],
      { cwd: projectPath }
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser", "--files", "src"]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    const nextOutput = logs.join("\n");
    expect(nextOutput).toContain("task: Q001 - fix the parser");
    expect(nextOutput).not.toContain("task: P001");

    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "x.ts"), "export const x = 2;\n", "utf8");
    await stage(projectPath, "lib/x.ts");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);
    const checkpointOutput = logs.join("\n");
    expect(checkpointOutput).toContain("status: FAILED");
    expect(checkpointOutput).toContain("outside allowed files");

    const state = await pipeline(projectPath);
    expect(state.currentTaskId).toBe("Q001");
    expect(state.completed).not.toContain("Q001");
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

  it.each([
    {
      name: "healthy",
      status: { success: true, targetPath: ".", initialized: true, activeFeature: { id: "001", slug: "pipeline" } },
      expectedStatus: "BLOCKED"
    },
    {
      name: "configured-unhealthy",
      status: { success: false, targetPath: ".", initialized: true },
      expectedStatus: "INCONCLUSIVE"
    }
  ])(
    "AC007: stops before quick side effects when Kit is $name",
    async ({ status, expectedStatus }) => {
      const projectPath = await createRepo();
      await mkdir(join(projectPath, ".visp"), { recursive: true });
      await writeFile(join(projectPath, ".visp", "policy.json"), JSON.stringify({ rules: [] }), "utf8");
      const shim = await createVispShim({ status: { stdout: status } });
      process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;

      await runCli(["node", "visp-hyper", "--project", projectPath, "quick", "fix the parser"]);
      const output = logs.join("\n");

      expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(output).toContain(`status: ${expectedStatus}`);
      expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
      expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
      await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
      expect(process.exitCode).toBe(1);
    }
  );

  it("does not trust a completed-looking strict pipeline without live Kit authority", async () => {
    const projectPath = await createRepo();
    const featureDirName = "001-pipeline";
    const graph = {
      featureId: "001",
      featureSlug: "pipeline",
      tasks: [{ id: "T001", dependsOn: [], status: "done" }]
    };
    await mkdir(join(projectPath, ".visp", "features", featureDirName), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await writeFile(
      join(projectPath, ".visp", "features", featureDirName, "task-graph.json"),
      `${JSON.stringify(graph, null, 2)}\n`,
      "utf8"
    );

    const sessionId = "vh_strict_complete";
    const pipelineState = initialPipelineState(graph, {
      kind: "visp-kit",
      source: `.visp/features/${featureDirName}/task-graph.json`,
      featureId: "001",
      featureSlug: "pipeline"
    });
    const now = new Date().toISOString();
    await writeState(projectPath, {
      activeSessionId: sessionId,
      sessions: {
        [sessionId]: {
          id: sessionId,
          goal: "completed strict task",
          tool: "codex",
          projectPath,
          createdAt: now,
          updatedAt: now,
          phase: "implementation",
          relevantFiles: [],
          pipeline: pipelineState
        }
      }
    });

    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: null
        }
      }
    });
    process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("reason_code: kit_pipeline_completion_unconfirmed");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).not.toContain("BEGIN_VISP_PIPELINE_COMPLETE");
    expect(output).not.toContain("evidence_source: local");
  });

  it("legacy state without syntheticTasks still parses", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
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

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    const output = logs.join("\n");
    expect(output).toContain("reason_code: legacy_pipeline_identity");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
  });
});
