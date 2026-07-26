import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { initializeProject } from "../src/core/session-manager.js";

const execFileAsync = promisify(execFile);

const packageRoot = resolvePackageRoot();
const distIndex = join(packageRoot, "dist", "index.js");

function resolvePackageRoot(): string {
  // tests/ → package root
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
}

async function commit(projectPath: string, message: string): Promise<{ code: number }> {
  try {
    await execFileAsync(
      "git",
      ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", message],
      { cwd: projectPath }
    );
    return { code: 0 };
  } catch (error) {
    const code = (error as { code?: number }).code;
    return { code: typeof code === "number" ? code : 1 };
  }
}

async function writeQuickSession(
  projectPath: string,
  task: { id: string; allowedFiles?: string[] }
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260612_hooks001";
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
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "hyper", "state.json"), JSON.stringify(state, null, 2), "utf8");
}

describe("hooks git", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("AC004a: installs an executable pre-commit hook with marker; re-run reports updated", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-"));
    await gitInit(projectPath);

    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "git"]);

    const hookPath = join(projectPath, ".git", "hooks", "pre-commit");
    expect(await fileExists(hookPath)).toBe(true);
    // POSIX exec-mode bits are meaningless on win32 (files carry no chmod +x
    // permission), so only assert the executable bit where it exists.
    if (process.platform !== "win32") {
      const mode = (await stat(hookPath)).mode;
      expect(mode & 0o111).not.toBe(0);
    }
    const content = await readFile(hookPath, "utf8");
    expect(content).toContain("# visp-hyper-guard hook");
    expect(content).toContain("guard --staged");
    expect(logs.join("\n")).toContain("hooks git: installed .git/hooks/pre-commit");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "git"]);
    expect(logs.join("\n")).toContain("hooks git: updated .git/hooks/pre-commit");
  });

  it("AC004b: a foreign pre-commit hook is preserved and a warning is printed", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-"));
    await gitInit(projectPath);
    const hookPath = join(projectPath, ".git", "hooks", "pre-commit");
    const foreign = "#!/bin/sh\necho custom hook\n";
    await writeFile(hookPath, foreign, "utf8");

    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "git"]);

    expect(await readFile(hookPath, "utf8")).toBe(foreign);
    expect(logs.join("\n")).toContain("warning: existing pre-commit hook found; not overwriting.");
  });

  it("AC004c: a non-git directory errors with exit code 1", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-nogit-"));

    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "git"]);

    expect(errors.join("\n")).toContain("error: not a git repository (run inside a project with .git).");
    expect(process.exitCode).toBe(1);
  });

  it("installs into Git's effective hooks directory for a linked worktree with spaces", async () => {
    const repository = await mkdtemp(join(tmpdir(), "visp-hooks-main "));
    const worktree = join(await mkdtemp(join(tmpdir(), "visp-hooks-parent ")), "linked worktree");
    await gitInit(repository);
    await writeFile(join(repository, "README.md"), "# Main\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await commit(repository, "init");
    await execFileAsync("git", ["worktree", "add", "-b", "linked-test", worktree], {
      cwd: repository
    });

    await runCli(["node", "visp-hyper", "--project", worktree, "hooks", "git"]);

    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: worktree
    });
    const hooksDir = stdout.trim();
    const hookPath = join(
      hooksDir.startsWith("/") ? hooksDir : join(worktree, hooksDir),
      "pre-commit"
    );
    expect(await readFile(hookPath, "utf8")).toContain("# visp-hyper-guard hook");
  });
});

describe("hooks ci", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("AC005: writes the workflow, is idempotent without --force, and rewrites owned files with --force", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-ci-"));
    const workflowPath = join(projectPath, ".github", "workflows", "visp-hyper-gate.yml");

    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "ci"]);
    expect(await fileExists(workflowPath)).toBe(true);
    const content = await readFile(workflowPath, "utf8");
    expect(content).toContain("# visp-hyper-guard workflow");
    expect(content).toContain('--base "origin/${{ github.base_ref }}"');
    expect(logs.join("\n")).toContain("hooks ci: installed .github/workflows/visp-hyper-gate.yml");

    // Re-run without --force → up to date.
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "ci"]);
    expect(logs.join("\n")).toContain("hooks ci: up to date (use --force to rewrite)");

    // Our marker + --force → rewritten.
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "ci", "--force"]);
    expect(logs.join("\n")).toContain("hooks ci: updated .github/workflows/visp-hyper-gate.yml");

    // Foreign workflow → skip + warning, even with --force.
    logs = [];
    const foreign = "name: not ours\n";
    await writeFile(workflowPath, foreign, "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "ci", "--force"]);
    expect(await readFile(workflowPath, "utf8")).toBe(foreign);
    expect(logs.join("\n")).toContain("warning: existing workflow found; not overwriting.");
  });
});

describe("hooks git mechanical enforcement", () => {
  beforeAll(async () => {
    // The installed hook invokes `node dist/index.js guard --staged`. Ensure dist
    // exists AND is current enough to expose the guard command (it may predate the
    // guard/hooks work). `pnpm test` does not build, so build on demand.
    const built = (await fileExists(distIndex))
      ? (await readFile(distIndex, "utf8")).includes('"guard"')
      : false;
    if (!built) {
      await execFileAsync("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
    }
  }, 320_000);

  it("AC006: an installed hook rejects an out-of-scope commit and allows an in-scope one", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-e2e-"));
    await mkdir(join(projectPath, "src"), { recursive: true });
    await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
    await gitInit(projectPath);
    await execFileAsync("git", ["add", "."], { cwd: projectPath });
    await commit(projectPath, "init");

    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });

    // Install the hook (silence its log).
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli(["node", "visp-hyper", "--project", projectPath, "hooks", "git"]);
    logSpy.mockRestore();

    // Out-of-scope file staged → commit must be rejected.
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await execFileAsync("git", ["add", "lib/rogue.ts"], { cwd: projectPath });
    const rejected = await commit(projectPath, "rogue commit");
    expect(rejected.code).not.toBe(0);

    // Unstage rogue, stage an in-scope file → commit succeeds.
    await execFileAsync("git", ["reset", "lib/rogue.ts"], { cwd: projectPath });
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await execFileAsync("git", ["add", "src/ok.ts"], { cwd: projectPath });
    const allowed = await commit(projectPath, "ok commit");
    expect(allowed.code).toBe(0);
  }, 60_000);
});

describe("init hooks-git hint", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the hooks git hint after a tool asset install", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-hooks-init-"));
    await runCli(["node", "visp-hyper", "--project", projectPath, "init", "--tool", "generic"]);
    expect(logs.join("\n")).toContain(
      "hint: run `visp-hyper hooks git` to block out-of-scope commits mechanically."
    );
  });
});
