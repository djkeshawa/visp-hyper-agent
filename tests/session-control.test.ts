import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { contextPackPathIfExists } from "../src/cli/commands/shared.js";

const execFileAsync = promisify(execFile);

async function createGitProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-session-control-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync("git", ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"], {
    cwd: projectPath
  });
  return projectPath;
}

async function startSession(projectPath: string): Promise<void> {
  await runCli(["node", "visp-hyper", "--project", projectPath, "start", "feature"]);
}

describe("session control commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints bounded next action without an active session", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-next-"));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

    expect(logs.join("\n")).toContain("BEGIN_VISP_NEXT_ACTION");
    expect(logs.join("\n")).toContain("session_id: none");
    expect(logs.join("\n")).toContain("END_VISP_NEXT_ACTION");
  });

  it("reports generated files, checkpoint, review, and memory status", async () => {
    const projectPath = await createGitProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await startSession(projectPath);
    logs.length = 0;

    await runCli(["node", "visp-hyper", "--project", projectPath, "status"]);

    const status = logs.join("\n");
    expect(status).toContain("Generated files: session.md");
    expect(status).toContain("context-manifest.json");
    expect(status).toContain("Context freshness: untracked");
    expect(status).toContain("Last checkpoint: missing");
    expect(status).toContain("Last review: missing");
    expect(status).toContain("Memory: not remembered");
  });

  it("appends checkpoint entries with diff stat and changed files", async () => {
    const projectPath = await createGitProject();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await startSession(projectPath);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);

    const checkpoints = await readFile(join(projectPath, ".visp", "hyper", "current", "checkpoints.md"), "utf8");
    expect(checkpoints.match(/## Checkpoint/g)).toHaveLength(2);
    expect(checkpoints).toContain("src/feature.ts");
  });

  it("writes review report and bounded review result with warnings", async () => {
    const projectPath = await createGitProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await startSession(projectPath);
    logs.length = 0;
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 3;\n", "utf8");

    await runCli(["node", "visp-hyper", "--project", projectPath, "review"]);

    const stdout = logs.join("\n");
    const report = await readFile(join(projectPath, ".visp", "hyper", "current", "review-report.md"), "utf8");
    expect(stdout).toContain("BEGIN_VISP_REVIEW_RESULT");
    expect(stdout).toContain("warnings:");
    expect(stdout).toContain("END_VISP_REVIEW_RESULT");
    expect(report).toContain("No test changes detected for this diff.");
  });

  it("resolves repeated task context from the pinned feature only", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-context-identity-"));
    const oldContext = join(projectPath, ".visp", "features", "001-old", "context");
    const newContext = join(projectPath, ".visp", "features", "999-new", "context");
    await mkdir(oldContext, { recursive: true });
    await mkdir(newContext, { recursive: true });
    await writeFile(join(oldContext, "T001.context.json"), "{}\n", "utf8");
    await writeFile(join(newContext, "T001.context.json"), "{}\n", "utf8");

    await expect(
      contextPackPathIfExists(projectPath, "T001", {
        kind: "visp-kit",
        source: ".visp/features/001-old/task-graph.json",
        featureId: "001",
        featureSlug: "old"
      })
    ).resolves.toBe(".visp/features/001-old/context/T001.context.json");
    await expect(contextPackPathIfExists(projectPath, "T001")).resolves.toBeUndefined();
  });
});
