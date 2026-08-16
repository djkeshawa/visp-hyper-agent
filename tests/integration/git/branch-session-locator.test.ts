import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitBranchSessionLocator } from "../../../src/core/branch-session-locator.js";
import {
  createSession,
  getActiveSession,
  initializeProject,
  updateActiveSession
} from "../../../src/core/session-manager.js";

const execFileAsync = promisify(execFile);

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function createGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-branch-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, timeout: 5000 });
  await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir, timeout: 5000 });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: 5000 });
  await writeFile(join(dir, ".gitkeep"), "", "utf8");
  await execFileAsync("git", ["add", ".gitkeep"], { cwd: dir, timeout: 5000 });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir, timeout: 5000 });
  return dir;
}

describe("GitBranchSessionLocator", () => {
  describe("currentBranch()", () => {
    it("AC003a: returns the branch name for an initialized git repo", async () => {
      const gitAvailable = await isGitAvailable();
      if (!gitAvailable) {
        return;
      }

      // Need at least one commit so HEAD is resolvable
      const dir = await createGitRepo();

      const locator = new GitBranchSessionLocator();
      const branch = await locator.currentBranch(dir);

      expect(branch).toBe("main");
    });

    it("AC003b: returns null for a directory without a git repo", async () => {
      const dir = await mkdtemp(join(tmpdir(), "visp-nogit-"));

      const locator = new GitBranchSessionLocator();
      const branch = await locator.currentBranch(dir);

      expect(branch).toBeNull();
    });
  });

  describe("sessionKey()", () => {
    it("AC003c: appends branch with # separator", () => {
      const locator = new GitBranchSessionLocator();
      expect(locator.sessionKey("/p", "main")).toBe("/p#main");
    });

    it("AC003c: returns projectPath unchanged when branch is null", () => {
      const locator = new GitBranchSessionLocator();
      expect(locator.sessionKey("/p", null)).toBe("/p");
    });
  });
});

describe("branch-keyed session resolution", () => {
  it("each branch resumes its own session; switching back restores the earlier one", async () => {
    if (!(await isGitAvailable())) {
      return;
    }
    const dir = await createGitRepo();

    const mainSession = await createSession({
      projectPath: dir,
      goal: "main work",
      tool: "codex",
      relevantFiles: []
    });
    expect((await getActiveSession(dir))?.id).toBe(mainSession.id);

    await execFileAsync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir, timeout: 5000 });
    // A fresh branch has no session of its own yet → falls back to the global one.
    expect((await getActiveSession(dir))?.id).toBe(mainSession.id);

    const featureSession = await createSession({
      projectPath: dir,
      goal: "feature work",
      tool: "codex",
      relevantFiles: []
    });
    expect((await getActiveSession(dir))?.id).toBe(featureSession.id);

    // Updates on this branch land on the branch's session.
    await updateActiveSession(dir, (session) => ({ ...session, phase: "review" }));

    await execFileAsync("git", ["checkout", "-q", "main"], { cwd: dir, timeout: 5000 });
    const backOnMain = await getActiveSession(dir);
    expect(backOnMain?.id).toBe(mainSession.id);
    expect(backOnMain?.phase).toBe("implementation");
  });

  it("legacy state without activeSessionByBranch still resolves via activeSessionId", async () => {
    if (!(await isGitAvailable())) {
      return;
    }
    const dir = await createGitRepo();
    await initializeProject(dir);
    const statePath = join(dir, ".visp", "hyper", "state.json");
    const now = new Date().toISOString();
    const legacy = {
      activeSessionId: "vh_legacy_1",
      sessions: {
        vh_legacy_1: {
          id: "vh_legacy_1",
          goal: "legacy",
          tool: "codex",
          projectPath: dir,
          createdAt: now,
          updatedAt: now,
          phase: "implementation",
          relevantFiles: []
        }
      }
    };
    await writeFile(statePath, JSON.stringify(legacy, null, 2), "utf8");

    expect((await getActiveSession(dir))?.id).toBe("vh_legacy_1");
    expect(JSON.parse(await readFile(statePath, "utf8")).activeSessionByBranch).toBeUndefined();
  });
});
