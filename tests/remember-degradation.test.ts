import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);

async function createGitProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-remember-degrade-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  return projectPath;
}

describe("remember degrades when the local memory write fails", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns and still completes (does not crash) when the session-history path is not writable", async () => {
    const projectPath = await createGitProject();
    const logs: string[] = [];
    const warnings: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => logs.push(String(m)));
    vi.spyOn(console, "warn").mockImplementation((m?: unknown) => warnings.push(String(m)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "feature", "--tool", "generic"]);

    // Sabotage only the write *target*: occupy this session's memory file path
    // with a directory so the atomic write (rename onto the path) fails — while
    // leaving the rest of the .visp tree intact so initializeProject still works.
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    const sessionId: string = state.activeSessionId;
    expect(sessionId).toBeTruthy();
    await mkdir(join(projectPath, ".visp", "memory", "session-history", `${sessionId}.md`), { recursive: true });

    logs.length = 0;
    warnings.length = 0;

    // Must resolve (not reject) — DEGRADE NEVER CRASH.
    await expect(
      runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"])
    ).resolves.toBeUndefined();

    expect(warnings.join("\n")).toContain("local session memory could not be written");
    // Failed persistence must not advance the session or print a success claim.
    expect(logs.join("\n")).toContain("Memory not persisted locally");
    expect(logs.join("\n")).toContain("session was not marked remembered");
    expect(logs.join("\n")).not.toContain("Session learnings recorded.");
    expect(logs.join("\n")).not.toMatch(/Memory written to/);
    const after = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    );
    expect(after.sessions[sessionId].phase).toBe("implementation");
  });
});
