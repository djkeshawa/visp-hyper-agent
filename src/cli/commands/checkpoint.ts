import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command, Option } from "commander";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { collectLocalEvidence } from "../../quality/local-evidence.js";
import { harvestSkillProposals } from "./remember.js";
import { advance, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import {
  computeSuggestedTier,
  escalate,
  renderModelRouting
} from "../../routing/routing-engine.js";
import { readRoutingState, writeRoutingState } from "../../routing/routing-state.js";
import { appendAttempt, readTelemetry } from "../../telemetry/telemetry-store.js";
import { printWarnings, resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

// Default tier recorded in telemetry when the orchestrator does not report
// which tier actually executed the task via `--tier`.
const DEFAULT_TIER = "implementer";

export function checkpointCommand(): Command {
  return new Command("checkpoint")
    .description("Capture current progress and git diff summary.")
    .addOption(new Option("--task <task-id>", "Run pipeline verify/review for the active task and advance the pipeline."))
    .addOption(new Option("--tier <tier>", "Model tier that actually executed the task (recorded in telemetry)."))
    .action(async function (this: Command, options: { task?: string; tier?: string }) {
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

      // Disk graph first; fall back to a session's synthetic graph (e.g. a `quick`
      // session) which exists nowhere on disk.
      const syntheticTasks = session.pipeline?.syntheticTasks;
      const graph =
        (await loadTaskGraph(projectPath)) ??
        (syntheticTasks && syntheticTasks.length > 0 ? { tasks: syntheticTasks } : null);
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

      const task = currentTask(graph, session.pipeline!);
      const taskClass = task?.riskLevel ?? "unknown";

      const kit = await detectVisp(projectPath);
      let verifyPassed: boolean;
      let reviewPassed: boolean;
      let evidenceSource: "kit" | "local";
      let localFindings: string[] = [];

      if (kit.available) {
        const bridge = new KitCommandBridge({ projectPath });
        const verify = await bridge.verify(taskId);
        const review = await bridge.review(taskId);
        printWarnings(bridge.warnings);
        verifyPassed = verify?.success === true;
        reviewPassed = review?.success === true;
        evidenceSource = "kit";
      } else {
        const config = await readConfig(projectPath);
        const evidence = await collectLocalEvidence({
          projectPath,
          task: {
            id: taskId,
            allowedFiles: task?.allowedFiles,
            validationCommands: task?.validationCommands
          },
          blockedPaths: config.blockedPaths
        });
        verifyPassed = evidence.verifyPassed;
        reviewPassed = evidence.reviewPassed;
        localFindings = evidence.findings;
        evidenceSource = "local";
        printWarnings([...kit.warnings, ...evidence.warnings]);
      }

      const passed = verifyPassed && reviewPassed;
      try {
        await appendAttempt(projectPath, {
          taskId,
          taskClass,
          tier: options.tier ?? DEFAULT_TIER,
          verifyPassed,
          reviewPassed,
          sessionId: session.id
        });
      } catch (error) {
        console.log(`warning: telemetry attempt was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }

      const nextState = advance(
        session.pipeline!,
        graph,
        { verifyPassed, reviewPassed, detail: `${evidenceSource}-evidence` },
        new Date().toISOString()
      );
      await updateActiveSession(projectPath, (current) => ({ ...current, pipeline: nextState }));

      // Quality recovers unconditionally: a checkpoint failure quarantines the
      // task class so future routing forces the strongest tier until it expires.
      if (!passed) {
        try {
          const { state } = await readRoutingState(projectPath);
          const hyperState = await readState(projectPath);
          const escalated = escalate({
            state,
            taskId,
            taskClass,
            sessionCount: Object.keys(hyperState.sessions).length,
            now: new Date().toISOString()
          });
          await writeRoutingState(projectPath, escalated);
        } catch (error) {
          console.log(`warning: routing escalation was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const lines = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        `task: ${taskId}`,
        `verify: ${verifyPassed ? "PASSED" : "FAILED"}`,
        `review: ${reviewPassed ? "PASSED" : "FAILED"}`,
        `evidence_source: ${evidenceSource}`
      ];
      if (localFindings.length > 0) {
        lines.push("findings:");
        for (const finding of localFindings) {
          lines.push(` - ${finding}`);
        }
      }
      lines.push(`status: ${passed ? "PASSED" : "FAILED"}`);
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

      // On a pass with a next task, advise the routing tier for that task.
      if (passed && nextState.currentTaskId) {
        const nextTask = graph.tasks.find((entry) => entry.id === nextState.currentTaskId);
        if (nextTask) {
          try {
            const { data: telemetry } = await readTelemetry(projectPath);
            const { state: routingState } = await readRoutingState(projectPath);
            const hyperState = await readState(projectPath);
            const suggestion = computeSuggestedTier({
              task: nextTask,
              attempts: telemetry.attempts,
              routingState,
              sessionCount: Object.keys(hyperState.sessions).length
            });
            console.log("");
            console.log(renderModelRouting(suggestion));
          } catch {
            // Advisory only; never fail the checkpoint because routing could not be computed.
          }
        }
      }

      const config = await readConfig(projectPath);
      const harvest = await harvestSkillProposals(projectPath, config, session);
      for (const line of harvest.lines) {
        console.log(line);
      }
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
