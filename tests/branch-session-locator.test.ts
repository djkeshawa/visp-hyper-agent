import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { GitBranchSessionLocator } from "../src/core/branch-session-locator.js";

const execFileAsync = promisify(execFile);

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe("GitBranchSessionLocator", () => {
  describe("currentBranch()", () => {
    it("AC003a: returns the branch name for an initialized git repo", async () => {
      const gitAvailable = await isGitAvailable();
      if (!gitAvailable) {
        return;
      }

      const dir = await mkdtemp(join(tmpdir(), "visp-branch-"));
      await execFileAsync("git", ["init", "-b", "main"], { cwd: dir, timeout: 5000 });
      await execFileAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir, timeout: 5000 });
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir, timeout: 5000 });
      // Need at least one commit so HEAD is resolvable
      await writeFile(join(dir, ".gitkeep"), "", "utf8");
      await execFileAsync("git", ["add", ".gitkeep"], { cwd: dir, timeout: 5000 });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: dir, timeout: 5000 });

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
