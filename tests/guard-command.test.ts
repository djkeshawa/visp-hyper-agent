import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { initializeProject, readState, writeState } from "../src/core/session-manager.js";
import { checkScope, collectChangedFiles } from "../src/governance/scope-guard.js";
import * as kitBridge from "../src/kit/kit-command-bridge.js";
import { initialPipelineState } from "../src/pipeline/pipeline-engine.js";
import { toolOnlyPath } from "./helpers/tool-path.js";
import { createVispShim, type ShimSpec } from "./helpers/visp-shim.js";

// Resolve every helper's git call the same way the product does, so bare
// commands still spawn when the test replaces PATH with an isolated tool dir.
const execFileAsync = execFileResolved;

const originalPath = process.env.PATH;

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await commit(projectPath, "init");
}

async function commit(projectPath: string, message: string): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", message],
    { cwd: projectPath }
  );
}

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-"));
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
 * A PATH directory exposing git + node but no `visp` binary, so the kit-less
 * branch is exercised (mirrors local-evidence.test.ts technique).
 */
async function gitNodeOnlyPath(): Promise<string> {
  return toolOnlyPath(["git"]);
}

function workflowActionFixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T900",
    goal: "Use the authoritative guard scope",
    requiredReads: [],
    writablePaths: ["src"],
    forbiddenPaths: [],
    acceptanceOracles: [],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp implement",
    ...overrides
  };
}

function healthyKitSpec(extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        targetPath: ".",
        initialized: true,
        activeFeature: { id: "001", slug: "strict-guard" },
        activeTask: { id: "T900", title: "Guard scope", status: "ready" }
      }
    },
    next: { stdout: workflowActionFixture() },
    ...extra
  };
}

async function configureKit(projectPath: string, spec: ShimSpec = healthyKitSpec()): Promise<void> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const shim = await createVispShim(spec);
  process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
}

/**
 * Write a hyper state with an active quick-style session whose pipeline declares
 * a single synthetic task (no on-disk task graph).
 */
async function writeQuickSession(
  projectPath: string,
  task: { id: string; allowedFiles?: string[]; forbiddenFiles?: string[] }
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260612_test0001";
  const syntheticTask = {
    id: task.id,
    dependsOn: [],
    allowedFiles: task.allowedFiles,
    forbiddenFiles: task.forbiddenFiles
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

describe("checkScope", () => {
  it("flags a blocked path even with no allow list", () => {
    const violations = checkScope([".env"], { blockedPaths: [".env"] });
    expect(violations).toEqual([{ file: ".env", rule: "blocked-path" }]);
  });

  it("flags a blocked path that takes precedence over allow list", () => {
    const violations = checkScope(["node_modules/x.js"], {
      allowedFiles: ["node_modules"],
      blockedPaths: ["node_modules"]
    });
    expect(violations).toEqual([{ file: "node_modules/x.js", rule: "blocked-path" }]);
  });

  it("does not check outside-allowed when allowedFiles is empty or absent", () => {
    expect(checkScope(["lib/x.ts"], { blockedPaths: [] })).toEqual([]);
    expect(checkScope(["lib/x.ts"], { allowedFiles: [], blockedPaths: [] })).toEqual([]);
  });

  it("flags outside-allowed only when an allow list is present", () => {
    const violations = checkScope(["lib/x.ts"], { allowedFiles: ["src"], blockedPaths: [] });
    expect(violations).toEqual([{ file: "lib/x.ts", rule: "outside-allowed" }]);
  });

  it("matches allowed entries by exact, prefix, and trailing slash", () => {
    const blockedPaths: string[] = [];
    // exact
    expect(
      checkScope(["src/a.ts"], { allowedFiles: ["src/a.ts"], blockedPaths })
    ).toEqual([]);
    // <entry>/ prefix
    expect(checkScope(["src/a.ts"], { allowedFiles: ["src"], blockedPaths })).toEqual([]);
    // trailing slash
    expect(checkScope(["src/a.ts"], { allowedFiles: ["src/"], blockedPaths })).toEqual([]);
    // a sibling that shares a prefix string but not a path boundary is OUT
    expect(checkScope(["srcother/a.ts"], { allowedFiles: ["src"], blockedPaths })).toEqual([
      { file: "srcother/a.ts", rule: "outside-allowed" }
    ]);
  });
});

describe("collectChangedFiles", () => {
  it("staged returns only staged files", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "staged.ts"), "export const s = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    // An unstaged working-tree change that must NOT appear in staged mode.
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    const result = await collectChangedFiles(projectPath, { mode: "staged" });
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual(["src/staged.ts"]);
  });

  it("all returns the union of staged and working-tree changes", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "staged.ts"), "export const s = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    const result = await collectChangedFiles(projectPath, { mode: "all" });
    expect(result.warnings).toEqual([]);
    expect(new Set(result.files)).toEqual(new Set(["src/staged.ts", "src/feature.ts"]));
  });

  it("base returns files committed on a branch off the base ref", async () => {
    const projectPath = await createRepo();
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: projectPath });
    await writeFile(join(projectPath, "src", "branch.ts"), "export const b = 1;\n", "utf8");
    await stage(projectPath, "src/branch.ts");
    await commit(projectPath, "branch work");

    const result = await collectChangedFiles(projectPath, { mode: "base", baseRef: "main" });
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual(["src/branch.ts"]);
  });

  it("a non-git directory degrades to empty files plus a warning", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-nogit-"));
    const result = await collectChangedFiles(projectPath, { mode: "all" });
    expect(result.ok).toBe(false);
    expect(result.files).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("guard command integration", () => {
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

  it("AC001: staged out-of-scope file is BLOCKED with exit code 1", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: Q001");
    expect(output).toContain("status: BLOCKED");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(process.exitCode).toBe(1);
  });

  it("AC001: staged in-scope file is PASSED with no error exit code", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: Q001");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("- none");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC004: a disk plan cannot replace the active quick session scope", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "PLAN.md"), "- [ ] unrelated disk task\n", "utf8");
    await stage(projectPath, "PLAN.md");
    await commit(projectPath, "add unrelated plan");
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const rogue = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: Q001");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a tampered quick graph cannot authorize a broader scope", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    const state = await readState(projectPath);
    const pipeline = state.sessions[state.activeSessionId!]!.pipeline!;
    pipeline.syntheticTasks![0]!.allowedFiles = ["lib"];
    await writeState(projectPath, state);
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const rogue = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: pipeline_graph_mismatch");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a legacy pipeline cannot authorize guard scope", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    const state = await readState(projectPath);
    const pipeline = state.sessions[state.activeSessionId!]!.pipeline!;
    delete pipeline.graphIdentity;
    delete pipeline.taskKeys;
    delete pipeline.graphFingerprint;
    await writeState(projectPath, state);
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: pipeline_identity_missing");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a completed pipeline cannot degrade to unrestricted scope", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    const state = await readState(projectPath);
    const pipeline = state.sessions[state.activeSessionId!]!.pipeline!;
    pipeline.currentTaskId = null;
    pipeline.completed = ["Q001"];
    pipeline.stepHistory = [
      { taskId: "Q001", action: "checkpoint-passed", at: new Date().toISOString() }
    ];
    await writeState(projectPath, state);
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const rogue = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: guard_scope_unavailable");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: local task forbidden files override its allow list", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, {
      id: "Q001",
      allowedFiles: ["src"],
      forbiddenFiles: ["src/secret.ts"]
    });
    await writeFile(join(projectPath, "src", "secret.ts"), "export const secret = 1;\n", "utf8");
    await stage(projectPath, "src/secret.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("src/secret.ts: blocked path");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC002: no session/pipeline reports scope none and passes an ordinary file", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    await writeFile(join(projectPath, "src", "ordinary.ts"), "export const o = 1;\n", "utf8");
    await stage(projectPath, "src/ordinary.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: none");
    expect(output).toContain("status: PASSED");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC002: blocked paths apply even with no session", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    await writeFile(join(projectPath, ".env"), "SECRET=1\n", "utf8");
    await stage(projectPath, ".env");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: none");
    expect(output).toContain("status: BLOCKED");
    expect(output).toContain(".env: blocked path");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: --base picks up files committed on a branch", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: projectPath });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");
    await commit(projectPath, "rogue commit");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard", "--base", "main"]);

    const output = logs.join("\n");
    expect(output).toContain("checked: 1 file(s) (base main)");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a local non-git directory fails closed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-nogit-"));
    await initializeProject(projectPath);

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: changed_files_unavailable");
    expect(output).not.toContain("status: PASSED");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: an invalid local --base ref fails closed", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    process.env.PATH = await gitNodeOnlyPath();

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--base",
      "missing-ref"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: changed_files_unavailable");
    expect(output).not.toContain("status: PASSED");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    {
      name: "feature only",
      args: ["--feature", "001-strict-guard"],
      reasonCode: "guard_scope_arguments_incomplete"
    },
    {
      name: "task only",
      args: ["--task", "T900"],
      reasonCode: "guard_scope_arguments_incomplete"
    },
    {
      name: "whitespace-padded feature",
      args: ["--feature", " 001-strict-guard", "--task", "T900"],
      reasonCode: "guard_scope_arguments_invalid"
    },
    {
      name: "empty task",
      args: ["--feature", "001-strict-guard", "--task", ""],
      reasonCode: "guard_scope_arguments_invalid"
    },
    {
      name: "multiline task",
      args: ["--feature", "001-strict-guard", "--task", "T900\nT901"],
      reasonCode: "guard_scope_arguments_invalid"
    }
  ])("AC004: rejects $name scope assertions", async ({ args, reasonCode }) => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard", ...args]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain(`reason_code: ${reasonCode}`);
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: explicit scope cannot invent authority without an active task", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    process.env.PATH = await gitNodeOnlyPath();

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--feature",
      "001-strict-guard",
      "--task",
      "T900"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: guard_scope_unavailable");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: configured guard uses the ready Kit action instead of local session scope", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["lib"] });
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: T900");
    expect(output).toContain("status: PASSED");
    expect(output).not.toContain("scope: Q001");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC004: exact Kit feature/task assertions pass against the ready action", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--feature",
      "001-strict-guard",
      "--task",
      "T900"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("scope: T900");
    expect(output).toContain("status: PASSED");
    expect(process.exitCode).toBeFalsy();
  });

  it.each([
    {
      name: "feature",
      feature: "999-wrong-feature",
      task: "T900",
      reasonCode: "guard_feature_mismatch"
    },
    {
      name: "task",
      feature: "001-strict-guard",
      task: "T901",
      reasonCode: "guard_task_mismatch"
    }
  ])("AC004: a mismatched Kit $name assertion fails closed", async ({ feature, task, reasonCode }) => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--feature",
      feature,
      "--task",
      task
    ]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain(`reason_code: ${reasonCode}`);
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: disagreement between Kit status and the ready action fails closed", async () => {
    const projectPath = await createRepo();
    await configureKit(
      projectPath,
      healthyKitSpec({
        status: {
          stdout: {
            success: true,
            targetPath: ".",
            initialized: true,
            activeFeature: { id: "001", slug: "strict-guard" },
            activeTask: { id: "T901", title: "Different task", status: "ready" }
          }
        }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: workflow_action_scope_mismatch");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a feature switch that reuses the task id fails closed", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);
    vi.spyOn(kitBridge, "detectVisp")
      .mockResolvedValueOnce({
        state: "healthy",
        available: true,
        warnings: [],
        status: {
          success: true,
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "001", slug: "strict-guard" },
          activeTask: { id: "T900", title: "Guard scope", status: "ready" }
        }
      })
      .mockResolvedValueOnce({
        state: "healthy",
        available: true,
        warnings: [],
        status: {
          success: true,
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "002", slug: "switched-feature" },
          activeTask: { id: "T900", title: "Reused task", status: "ready" }
        }
      });

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--feature",
      "001-strict-guard",
      "--task",
      "T900"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: workflow_action_scope_mismatch");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: a nonzero refreshed Kit status cannot authorize guard", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);
    vi.spyOn(kitBridge, "detectVisp")
      .mockResolvedValueOnce({
        state: "healthy",
        available: true,
        warnings: [],
        status: {
          success: true,
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "001", slug: "strict-guard" },
          activeTask: { id: "T900", title: "Guard scope", status: "ready" }
        }
      })
      .mockResolvedValueOnce({
        state: "configured-unhealthy",
        available: false,
        reasonCode: "status_nonzero",
        reason: "visp status exited with code 1.",
        warnings: ["visp status exited with code 1."]
      });

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--feature",
      "001-strict-guard",
      "--task",
      "T900"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: status_nonzero");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: configured guard applies Kit forbidden paths inside writable scope", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "secret.ts"), "export const secret = 1;\n", "utf8");
    await stage(projectPath, "src/secret.ts");
    await configureKit(
      projectPath,
      healthyKitSpec({
        next: {
          stdout: workflowActionFixture({ forbiddenPaths: ["src/secret.ts"] })
        }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("src/secret.ts: blocked path");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: an empty Kit writable scope blocks every observed change", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "nope.ts"), "export const nope = 1;\n", "utf8");
    await stage(projectPath, "src/nope.ts");
    await configureKit(
      projectPath,
      healthyKitSpec({
        next: { stdout: workflowActionFixture({ writablePaths: [] }) }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("src/nope.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: configured-unhealthy guard is inconclusive without local fallback", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(output).not.toContain("scope: Q001");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    {
      name: "malformed",
      next: { stdout: "not-json" },
      reasonCode: "strict_next_unavailable"
    },
    {
      name: "non-ready",
      next: {
        stdout: workflowActionFixture({
          taskId: null,
          writablePaths: [],
          verdict: "blocked",
          findings: ["VSP001: scan required"],
          nextCommand: "visp scan"
        }),
        exitCode: 1
      },
      reasonCode: "workflow_action_blocked"
    }
  ])("AC004: $name Kit action is inconclusive and non-zero", async ({ next, reasonCode }) => {
    const projectPath = await createRepo();
    await configureKit(projectPath, healthyKitSpec({ next }));

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain(`reason_code: ${reasonCode}`);
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(process.exitCode).toBe(1);
  });

  it("AC004: configured guard treats an unreadable Git diff as inconclusive", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-nogit-strict-"));
    await configureKit(projectPath);

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: changed_files_unavailable");
    expect(output).not.toContain("status: PASSED");
    expect(process.exitCode).toBe(1);
  });
});
