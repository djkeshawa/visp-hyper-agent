import { Command } from "commander";
import { getActiveSession, readState } from "../../core/session-manager.js";
import type { SessionRecord } from "../../core/types.js";
import type { KitTask } from "../../kit/kit-schemas.js";
import { readRelevantFailurePatterns } from "../../memory/failure-patterns.js";
import { effectiveGraph, evidenceRequirements } from "../../pipeline/adaptive-rules.js";
import { buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { contextPackPathIfExists, printWorkflowDirectiveIfAny, resolveProjectPath } from "./shared.js";

export function nextCommand(): Command {
  return new Command("next")
    .description("Print the next recommended action for the active session.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        console.log(
          [
            "BEGIN_VISP_NEXT_ACTION",
            "session_id: none",
            "next: run `visp-hyper start \"<goal>\"`",
            "END_VISP_NEXT_ACTION"
          ].join("\n")
        );
        return;
      }

      if (session.pipeline?.currentTaskId) {
        // Same resolution as checkpoint: disk graph, then the session's
        // synthetic graph, with injected remediation tasks merged in-memory.
        const syntheticTasks = session.pipeline.syntheticTasks;
        const baseGraph =
          (await loadTaskGraph(projectPath)) ??
          (syntheticTasks && syntheticTasks.length > 0 ? { tasks: syntheticTasks } : null);
        const graph = baseGraph ? effectiveGraph(baseGraph, session.pipeline) : null;
        if (!graph) {
          console.log("warning: pipeline state exists but the task graph could not be loaded.");
        } else {
          const task = currentTask(graph, session.pipeline);
          if (task) {
            const contextPackPath = await contextPackPathIfExists(projectPath, task.id);
            const knownFailureModes = await knownFailureModesFor(projectPath, task);
            console.log(buildActionBlock(task, { sessionId: session.id, contextPackPath, knownFailureModes }));
            await printAndRecordRouting(projectPath, task);
            printWorkflowDirectiveIfAny(graph, session.pipeline, session.tool, session.id);
            return;
          }
          console.log("warning: pipeline state exists but the current task is not in the task graph.");
        }
      }

      printLegacyNext(session);
    });
}

function printLegacyNext(session: SessionRecord): void {
  console.log(
    [
      "BEGIN_VISP_NEXT_ACTION",
      `session_id: ${session.id}`,
      `phase: ${session.phase}`,
      `goal: ${session.goal}`,
      "next: read .visp/hyper/current/agent-instructions.md and continue the implementation workflow",
      "END_VISP_NEXT_ACTION"
    ].join("\n")
  );
}

/**
 * Known failure modes for the task, surfaced as an optional action-block
 * section. Best-effort: an unreadable pattern store yields none.
 */
async function knownFailureModesFor(projectPath: string, task: KitTask): Promise<string[] | undefined> {
  try {
    const patterns = await readRelevantFailurePatterns(projectPath, {
      taskId: task.id,
      taskClass: task.riskLevel ?? "unknown",
      files: task.allowedFiles
    });
    const { knownFailureModes } = evidenceRequirements(task, patterns);
    return knownFailureModes.length > 0 ? knownFailureModes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compute the advisory model-routing suggestion for `task`, print it after the
 * action block, and persist the decision. Best-effort: a routing failure must
 * never break the next command, so errors are swallowed.
 */
async function printAndRecordRouting(projectPath: string, task: KitTask): Promise<void> {
  try {
    const [{ data: telemetry }, { state: routingState }, hyperState] = await Promise.all([
      readTelemetry(projectPath),
      readRoutingState(projectPath),
      readState(projectPath)
    ]);
    const suggestion = computeSuggestedTier({
      task,
      attempts: telemetry.attempts,
      routingState,
      sessionCount: Object.keys(hyperState.sessions).length
    });
    console.log("");
    console.log(renderModelRouting(suggestion));
    await recordRoutingDecision(projectPath, {
      taskId: suggestion.taskId,
      taskClass: suggestion.taskClass,
      tier: suggestion.suggestedTier,
      reason: suggestion.reason,
      at: new Date().toISOString()
    });
  } catch {
    // Advisory only; never fail the next command because routing could not be computed.
  }
}

