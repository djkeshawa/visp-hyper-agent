import { join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { initializeProject } from "../src/core/session-manager.js";
import { checkScope, collectChangedFiles } from "../src/governance/scope-guard.js";
import { toolOnlyPath } from "./helpers/tool-path.js";

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

/**
 * Write a hyper state with an active quick-style session whose pipeline declares
 * a single synthetic task (no on-disk task graph).
 */
async function writeQuickSession(
  projectPath: string,
  task: { id: string; allowedFiles?: string[] }
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260612_test0001";
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
    expect(result.files).toEqual([]);
    expect(result.warnings.length).toBe(1);
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

  it("AC003: a non-git directory degrades open with a warning and PASSES", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-nogit-"));
    await initializeProject(projectPath);

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("warning:");
    expect(output).toContain("status: PASSED");
    expect(process.exitCode).toBeFalsy();
  });
});
