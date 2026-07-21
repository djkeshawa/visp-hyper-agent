import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { captureGitBaseline, initializeProject } from "../src/core/session-manager.js";
import { initialPipelineState } from "../src/pipeline/pipeline-engine.js";

const execFileAsync = promisify(execFile);

const TASK_ID = "T001";

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-adapt-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  // Validation gate the test controls: exits 0 only once ok.txt exists.
  await writeFile(
    join(projectPath, "check.js"),
    "process.exit(require('node:fs').existsSync('ok.txt') ? 0 : 2);\n",
    "utf8"
  );
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  return projectPath;
}

/** Kit-less session whose synthetic task runs the controllable check.js gate. */
async function writeSession(
  projectPath: string,
  options: { riskLevel?: "low" | "high"; withoutValidation?: boolean } = {}
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260703_adapt001";
  const gitBaseline = await captureGitBaseline(projectPath);
  const task = {
    id: TASK_ID,
    title: "adaptive demo task",
    description: "adaptive demo task",
    dependsOn: [],
    allowedFiles: ["src", "ok.txt"],
    ...(options.withoutValidation ? {} : { validationCommands: ["node check.js"] }),
    status: "pending" as const,
    riskLevel: options.riskLevel ?? "low"
  };
  const pipeline = initialPipelineState(
    { tasks: [task] },
    { kind: "synthetic", source: `quick:${sessionId}` }
  );
  const state = {
    activeSessionId: sessionId,
    sessions: {
      [sessionId]: {
        id: sessionId,
        goal: "adaptive demo",
        tool: "codex",
        projectPath,
        createdAt: now,
        updatedAt: now,
        phase: "implementation",
        relevantFiles: [],
        gitBaseline,
        pipeline: {
          ...pipeline,
          gitBaseline,
          syntheticTasks: [task]
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

async function readPipeline(projectPath: string): Promise<any> {
  const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
  return state.sessions[state.activeSessionId].pipeline;
}

describe("checkpoint adaptive pipeline integration", () => {
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

  it("injects a remediation task on the second consecutive failure and returns to the original after it passes", async () => {
    const projectPath = await createRepo();
    await writeSession(projectPath);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    // First failure: no adaptation yet.
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", TASK_ID]);
    expect(logs.join("\n")).not.toContain("BEGIN_VISP_ADAPTATION");
    expect((await readPipeline(projectPath)).currentTaskId).toBe(TASK_ID);

    // Second consecutive failure: remediation task injected and made current.
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", TASK_ID]);
    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_ADAPTATION");
    expect(output).toContain("action: inject-remediation");
    expect(output).toContain(`remediation_task: R-${TASK_ID}-1`);
    // The remediation's own action block is printed for the agent.
    expect(output).toContain(`task: R-${TASK_ID}-1 - Remediate ${TASK_ID}`);

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe(`R-${TASK_ID}-1`);
    expect(pipeline.injectedTasks.map((task: any) => task.id)).toEqual([`R-${TASK_ID}-1`]);
    expect(pipeline.decisionLog).toHaveLength(1);
    expect(pipeline.stepHistory.at(-1)).toMatchObject({
      taskId: `R-${TASK_ID}-1`,
      action: "task-injected"
    });

    // `next` resolves the injected task like any other.
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    expect(logs.join("\n")).toContain(`task: R-${TASK_ID}-1`);

    // Make validation pass; the remediation checkpoint advances back to T001.
    await writeFile(join(projectPath, "ok.txt"), "fixed\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", `R-${TASK_ID}-1`]);
    const remediationOutput = logs.join("\n");
    expect(remediationOutput).toContain("status: PASSED");
    expect(remediationOutput).toContain(`next_task: ${TASK_ID}`);
    expect((await readPipeline(projectPath)).currentTaskId).toBe(TASK_ID);
  });

  it("strict evidence: missing validation remains inconclusive and cannot advance", async () => {
    const projectPath = await createRepo();
    // High-risk task with no validation commands anywhere: vacuous verify.
    await writeSession(projectPath, { riskLevel: "high", withoutValidation: true });
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", TASK_ID]);
    const output = logs.join("\n");
    expect(output).toContain("verify: INCONCLUSIVE");
    expect(output).toContain("no validation commands detected; verification is inconclusive");
    expect(output).not.toContain("action: inject-remediation");
  });

  it("escalates when the remediation task itself keeps failing", async () => {
    const projectPath = await createRepo();
    await writeSession(projectPath);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    // Two failures on T001 → remediation injected.
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", TASK_ID]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", TASK_ID]);
    expect((await readPipeline(projectPath)).currentTaskId).toBe(`R-${TASK_ID}-1`);

    // Two failures on the remediation → escalation directive, no nested remediation.
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", `R-${TASK_ID}-1`]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", `R-${TASK_ID}-1`]);
    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_ADAPTATION");
    expect(output).toContain("action: escalation-directive");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe(`R-${TASK_ID}-1`);
    expect(pipeline.injectedTasks).toHaveLength(1);
    expect(pipeline.stepHistory.at(-1)).toMatchObject({ action: "escalation-issued" });
  });
});
