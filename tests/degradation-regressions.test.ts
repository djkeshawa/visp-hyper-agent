import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { collectChangedFiles } from "../src/governance/scope-guard.js";
import { collectLocalEvidence } from "../src/quality/local-evidence.js";
import { analyzeDiff } from "../src/quality/diff-analyzer.js";
import { ProjectValidationRunner } from "../src/quality/validation-runner.js";
import { readSkillRegistry, recordUsage, writeSkillRegistry } from "../src/skills/skill-registry.js";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distIndex = join(packageRoot, "dist", "index.js");

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** A repository that has been `git init`-ed but has no commits, so HEAD does not resolve. */
async function createRepoWithoutCommits(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-no-commit-"));
  await writeFile(join(projectPath, "package.json"), '{"name":"demo"}\n', "utf8");
  await execFileAsync("git", ["init"], { cwd: projectPath });
  return projectPath;
}

async function createCommittedRepo(): Promise<string> {
  const projectPath = await createRepoWithoutCommits();
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  return projectPath;
}

/**
 * A project whose `test` script exits ZERO but writes more than Node's 1 MB
 * default execFile capture buffer. The writes are drained properly so the
 * output is not truncated by an early process exit.
 */
async function createNoisyPassingProject(): Promise<string> {
  const projectPath = await createCommittedRepo();
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node noisy.js" } }),
    "utf8"
  );
  await writeFile(
    join(projectPath, "noisy.js"),
    [
      'const line = "x".repeat(200) + "\\n";',
      "let written = 0;",
      "function pump() {",
      "  while (written < 12000) {",
      "    written += 1;",
      "    if (!process.stdout.write(line)) { process.stdout.once('drain', pump); return; }",
      "  }",
      '  console.log("ALL TESTS PASSED");',
      "}",
      "pump();"
    ].join("\n"),
    "utf8"
  );
  return projectPath;
}

describe("validation evidence is never invented (REG-VERIFY)", () => {
  it("a command that exits zero with >1MB of output is recorded as PASSED, not exit 1", async () => {
    const projectPath = await createNoisyPassingProject();
    const runner = new ProjectValidationRunner();

    const results = await runner.run(projectPath, ["npm run test"]);

    expect(results).toHaveLength(1);
    // Node's default 1 MB maxBuffer would kill the child and surface a
    // non-numeric error code, which used to be reported as a fabricated exit 1.
    expect(results[0]!.output.length).toBeGreaterThan(0);
    expect(results[0]!.exitCode).toBe(0);
    expect(results[0]!.spawnError).toBeUndefined();
  }, 60_000);

  it("a noisy passing suite yields verify PASSED evidence rather than a failed checkpoint", async () => {
    const projectPath = await createNoisyPassingProject();

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["npm run test"] },
      blockedPaths: []
    });

    expect(evidence.verifyVerdict).toBe("passed");
    expect(evidence.findings.some((line) => line.startsWith("verify failed"))).toBe(false);
  }, 60_000);

  it("a command killed by the validation timeout is inconclusive, not failed", async () => {
    const projectPath = await createCommittedRepo();
    const command = "node -e setTimeout(()=>{},60000)";
    const runner = new ProjectValidationRunner({ timeoutMs: 250, kitCommands: [command] });

    const results = await runner.run(projectPath, [command]);

    expect(results).toHaveLength(1);
    // A process we terminated never reported an exit status; claiming one would
    // quarantine the task class on evidence the command never gave.
    expect(results[0]!.exitCode).toBeNull();
    expect(results[0]!.spawnError).toMatch(/timeout/u);
  }, 60_000);
});

describe("git surfaces degrade in a repository without commits (REG-GIT)", () => {
  it("analyzeDiff reports the diff as unavailable instead of throwing", async () => {
    const projectPath = await createRepoWithoutCommits();

    const result = await analyzeDiff({ projectPath, relevantFiles: [], blockedPaths: [] });

    expect(result.diffAvailable).toBe(false);
    expect(result.changedFiles).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/could not be read/u);
  });

  it("`review` emits an inconclusive block and exits non-zero", async () => {
    const projectPath = await createRepoWithoutCommits();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "feature"]);
    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "review"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_REVIEW_RESULT");
    expect(output).toContain("status: inconclusive");
    expect(output).toContain("reason_code: changed_files_unavailable");
    expect(process.exitCode).toBe(1);
  }, 60_000);

  it("`checkpoint` writes its markdown with an unavailable diff stat instead of throwing", async () => {
    const projectPath = await createRepoWithoutCommits();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "feature"]);
    await expect(
      runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"])
    ).resolves.toBeUndefined();

    const markdown = await readFile(
      join(projectPath, ".visp", "hyper", "current", "checkpoints.md"),
      "utf8"
    );
    expect(markdown).toContain("Diff stat unavailable");
  }, 60_000);
});

describe("the skill registry survives concurrent writers (REG-SKILLS)", () => {
  it("ten concurrent recordUsage calls all land", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-skill-race-"));
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    await writeSkillRegistry(projectPath, {
      skills: [
        {
          name: "alpha",
          description: "a",
          whenToUse: "w",
          originSessionId: "s",
          installedAtSessionCount: 0,
          destinations: [],
          usedCount: 0,
          lastUsedAt: null,
          lastUsedSessionCount: null
        }
      ]
    });

    const recorded = await Promise.all(
      Array.from({ length: 10 }, () => recordUsage(projectPath, "alpha", { sessionCount: 1 }))
    );

    expect(recorded.every(Boolean)).toBe(true);
    const { registry } = await readSkillRegistry(projectPath);
    // An unlocked read-modify-write loses updates here; `report` prunes by this
    // counter, so a lost increment can retire a skill that is still in use.
    expect(registry.skills[0]!.usedCount).toBe(10);
  }, 60_000);
});

describe("session memory records the work that actually happened (REG-MEMORY)", () => {
  it("`remember` records staged and untracked files, not just unstaged edits", async () => {
    const projectPath = await createCommittedRepo();
    await writeFile(join(projectPath, "unstaged.ts"), "export const a = 1;\n", "utf8");
    await execFileAsync("git", ["add", "unstaged.ts"], { cwd: projectPath });
    await execFileAsync(
      "git",
      ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "add"],
      { cwd: projectPath }
    );
    await writeFile(join(projectPath, "unstaged.ts"), "export const a = 2;\n", "utf8");
    await writeFile(join(projectPath, "staged.ts"), "export const b = 1;\n", "utf8");
    await execFileAsync("git", ["add", "staged.ts"], { cwd: projectPath });
    await writeFile(join(projectPath, "untracked.ts"), "export const c = 1;\n", "utf8");

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "feature"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "did work"]);

    const historyDir = join(projectPath, ".visp", "memory", "session-history");
    const entries = await readdir(historyDir);
    expect(entries).toHaveLength(1);
    const recorded = await readFile(join(historyDir, entries[0]!), "utf8");

    // The old bare `git diff --name-only` saw only `unstaged.ts`, so an agent
    // that staged its work recorded a session that changed nothing.
    expect(recorded).toContain("unstaged.ts");
    expect(recorded).toContain("staged.ts");
    expect(recorded).toContain("untracked.ts");
    // Hyper's own regenerated runtime is not work the agent did.
    expect(recorded).not.toContain(".visp/hyper/");
  }, 60_000);
});

describe("guard rejects a base ref that git would read as an option (REG-GUARD)", () => {
  it("skips the scope check instead of passing the ref through", async () => {
    const projectPath = await createCommittedRepo();

    const result = await collectChangedFiles(projectPath, { mode: "base", baseRef: "--output=/tmp/x" });

    expect(result.files).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/not a valid revision/u);
  });
});

describe("the CLI never emits a bare stack trace (REG-BOUNDARY)", () => {
  it("wraps an unexpected failure in a parseable block and exits non-zero", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-boundary-"));
    // `remember` throws when no session exists; the boundary must catch it.
    const child = await execFileAsync(
      process.execPath,
      [distIndex, "--project", projectPath, "remember"],
      { cwd: packageRoot }
    ).catch((error: { code?: number; stdout?: string; stderr?: string }) => error);

    const stdout = (child as { stdout?: string }).stdout ?? "";
    expect(stdout).toContain("BEGIN_VISP_INTERNAL_ERROR");
    expect(stdout).toContain("reason_code: hyper_internal_error");
    expect(stdout).toContain("END_VISP_INTERNAL_ERROR");
    expect((child as { code?: number }).code).toBe(1);
  }, 60_000);
});

describe("the MCP server answers every id-bearing request (REG-MCP)", () => {
  it("returns a JSON-RPC error when a resource read fails instead of hanging", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-mcp-error-"));
    // A directory where a readable manifest is expected makes readTextIfExists
    // throw EISDIR — any non-ENOENT read error reaches the handler the same way.
    await mkdir(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), {
      recursive: true
    });

    const child = spawn(process.execPath, [distIndex, "serve", "--mcp", "--project", projectPath], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const responses: Array<{ id?: number; error?: { code: number; message: string } }> = [];
    let buffer = "";
    const failingId = 2;

    const answered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the failing request's response")),
        20_000
      );
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line.length === 0) continue;
          const parsed = JSON.parse(line) as { id?: number; error?: { code: number; message: string } };
          responses.push(parsed);
          if (parsed.id === failingId) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("server exited before answering the failing request"));
      });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: failingId,
        method: "resources/read",
        params: { uri: "visp-hyper://current/kit-read-contract" }
      })}\n`
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    await answered;
    child.stdin.end();
    child.kill();

    const failure = responses.find((message) => message.id === failingId);
    expect(failure?.error?.code).toBe(-32603);
    // A notification carries no id and must still go unanswered.
    expect(responses.filter((message) => message.id === undefined)).toEqual([]);
  }, 60_000);
});
