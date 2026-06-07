import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCommand } from "../src/cli/commands/start.js";
import { runCli } from "../src/cli/index.js";

const execFileAsync = promisify(execFile);

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-cli-workflow-"));
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

describe("CLI workflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the main local workflow and writes expected files", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "status"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "review"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "Functional workflow covered."]);

    const output = logs.join("\n");
    const handoff = await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8");
    const checkpoint = await readFile(join(projectPath, ".visp", "hyper", "current", "checkpoints.md"), "utf8");
    const review = await readFile(join(projectPath, ".visp", "hyper", "current", "review-report.md"), "utf8");
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    const memoryPath = join(projectPath, ".visp", "memory", "session-history", `${state.activeSessionId}.md`);
    const memory = await readFile(memoryPath, "utf8");

    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain("BEGIN_VISP_NEXT_ACTION");
    expect(output).toContain("BEGIN_VISP_REVIEW_RESULT");
    expect(handoff).toContain("\"toolProfile\": \"codex\"");
    expect(checkpoint).toContain("src/feature.ts");
    expect(review).toContain("No test changes detected for this diff.");
    expect(memory).toContain("Functional workflow covered.");
  });

  it("rejects unsupported tool values", async () => {
    const command = startCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync(["node", "start", "goal", "--tool", "unsupported"])).rejects.toThrow(/is invalid/);
  });
});
