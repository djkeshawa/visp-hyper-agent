import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command, Option } from "commander";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { getActiveSession, updateActiveSession } from "../../core/session-manager.js";
import { KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { advance, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import { appendAttempt } from "../../telemetry/telemetry-store.js";
import { resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

// Placeholder routing tier; deterministic routing lands in the next task.
const DEFAULT_TIER = "implementer";

export function checkpointCommand(): Command {
  return new Command("checkpoint")
    .description("Capture current progress and git diff summary.")
    .addOption(new Option("--task <task-id>", "Run pipeline verify/review for the active task and advance the pipeline."))
    .action(async function (this: Command, options: { task?: string }) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }

      await writeCheckpointMarkdown(projectPath, session.id, session.goal);

      if (!options.task) {
        console.log("Checkpoint written to .visp/hyper/current/checkpoints.md");
        return;
      }

      const taskId = options.task;
      const currentTaskId = session.pipeline?.currentTaskId;
      if (currentTaskId !== taskId) {
        console.log(
          [
            "BEGIN_VISP_CHECKPOINT_RESULT",
            `task: ${taskId}`,
            `error: task "${taskId}" does not match the active pipeline task (${currentTaskId ?? "none"}).`,
            "END_VISP_CHECKPOINT_RESULT"
          ].join("\n")
        );
        return;
      }

      const graph = await loadTaskGraph(projectPath);
      if (!graph) {
        console.log(
          [
            "BEGIN_VISP_CHECKPOINT_RESULT",
            `task: ${taskId}`,
            "error: the task graph could not be loaded.",
            "END_VISP_CHECKPOINT_RESULT"
          ].join("\n")
        );
        return;
      }

      const bridge = new KitCommandBridge({ projectPath });
      const verify = await bridge.verify(taskId);
      const review = await bridge.review(taskId);
      printWarnings(bridge.warnings);

      const verifyPassed = verify?.success === true;
      const reviewPassed = review?.success === true;
      const passed = verifyPassed && reviewPassed;

      const task = currentTask(graph, session.pipeline!);
      try {
        await appendAttempt(projectPath, {
          taskId,
          taskClass: task?.riskLevel ?? "unknown",
          tier: DEFAULT_TIER,
          verifyPassed,
          reviewPassed,
          sessionId: session.id
        });
      } catch (error) {
        console.log(`warning: telemetry attempt was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }

      const nextState = advance(session.pipeline!, graph, { verifyPassed, reviewPassed }, new Date().toISOString());
      await updateActiveSession(projectPath, (current) => ({ ...current, pipeline: nextState }));

      const lines = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        `task: ${taskId}`,
        `verify: ${verifyPassed ? "PASSED" : "FAILED"}`,
        `review: ${reviewPassed ? "PASSED" : "FAILED"}`,
        `status: ${passed ? "PASSED" : "FAILED"}`
      ];
      if (passed) {
        if (nextState.currentTaskId) {
          lines.push(`next_task: ${nextState.currentTaskId}`);
        } else {
          lines.push("pipeline_complete: true");
        }
      } else {
        lines.push(`instruction: Fix the reported findings and re-run checkpoint --task ${taskId}.`);
      }
      lines.push("END_VISP_CHECKPOINT_RESULT");
      console.log(lines.join("\n"));
    });
}

async function writeCheckpointMarkdown(projectPath: string, sessionId: string, goal: string): Promise<void> {
  const [{ stdout: stat }, { stdout: names }] = await Promise.all([
    execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: projectPath }),
    execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: projectPath })
  ]);
  const content = [
    `## Checkpoint ${new Date().toISOString()}`,
    "",
    `Session: ${sessionId}`,
    `Goal: ${goal}`,
    "",
    "## Git Diff Stat",
    "",
    stat.trim() || "_No diff._",
    "",
    "## Changed Files",
    "",
    ...(names.trim() ? names.trim().split("\n").map((file) => `- ${file}`) : ["_No changed files._"]),
    ""
  ].join("\n");
  const path = vispPath(projectPath, "hyper", "current", "checkpoints.md");
  const previous = await readTextIfExists(path);
  await writeText(path, previous ? `${previous.trimEnd()}\n\n${content}` : `# Checkpoints\n\n${content}`);
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  warnings.length = 0;
}
