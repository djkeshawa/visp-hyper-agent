import { Command } from "commander";
import { getActiveSession, readState } from "../../core/session-manager.js";
import type { SessionRecord } from "../../core/types.js";
import type { KitTask } from "../../kit/kit-schemas.js";
import { readRelevantFailurePatterns } from "../../memory/failure-patterns.js";
import { effectiveGraph, evidenceRequirements } from "../../pipeline/adaptive-rules.js";
import {
  buildActionBlock,
  currentTask,
  isPipelineComplete,
  loadTaskGraphByIdentity,
  readySet,
  validatePipelineState
} from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import {
  contextPackPathIfExists,
  printWorkflowDirectiveIfAny,
  renderPipelineComplete,
  renderPipelineIdentityStop,
  resolveProjectPath
} from "./shared.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";

export function nextCommand(): Command {
  return new Command("next")
    .description("Print the next recommended action for the active session.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: kit.reasonCode,
            reason: kit.reason
          })
        );
        return;
      }
      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const actionDiagnostic = await bridge.nextActionDiagnostic();
        if (actionDiagnostic.ok) {
          console.log(
            ["BEGIN_VISP_WORKFLOW_ACTION_V2", JSON.stringify(actionDiagnostic.value), "END_VISP_WORKFLOW_ACTION_V2"].join(
              "\n"
            )
          );
          return;
        }
        for (const warning of bridge.warnings) console.warn(`warning: ${warning}`);
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: actionDiagnostic.reasonCode,
            reason: actionDiagnostic.reason
          })
        );
        return;
      }
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

      if (session.pipeline) {
        const pipeline = session.pipeline;
        if (!pipeline.graphIdentity || !pipeline.taskKeys) {
          console.log(
            renderPipelineIdentityStop({
              sessionId: session.id,
              reasonCode: "legacy_pipeline_identity",
              reason: "The saved pipeline predates exact graph and task identity."
            })
          );
          return;
        }

        const loaded = await loadTaskGraphByIdentity(
          projectPath,
          pipeline.graphIdentity,
          pipeline.syntheticTasks
        );
        if (!loaded.ok) {
          console.log(
            renderPipelineIdentityStop({
              sessionId: session.id,
              reasonCode: loaded.reasonCode,
              reason: loaded.reason
            })
          );
          return;
        }

        const graph = effectiveGraph(loaded.graph, pipeline);
        const stateValidation = validatePipelineState(graph, pipeline, { sessionId: session.id });
        if (!stateValidation.ok) {
          console.log(
            renderPipelineIdentityStop({
              sessionId: session.id,
              reasonCode: stateValidation.reasonCode,
              reason: stateValidation.reason
            })
          );
          return;
        }

        if (isPipelineComplete(pipeline)) {
          console.log(
            renderPipelineComplete({
              sessionId: session.id,
              feature: pipeline.graphIdentity.featureId && pipeline.graphIdentity.featureSlug
                ? `${pipeline.graphIdentity.featureId}-${pipeline.graphIdentity.featureSlug}`
                : pipeline.graphIdentity.featureId ?? pipeline.graphIdentity.featureSlug,
              completedTasks: pipeline.completed
            })
          );
          return;
        }

        const task = currentTask(graph, pipeline);
        if (!task) {
          console.log(
            renderPipelineIdentityStop({
              sessionId: session.id,
              reasonCode: "pipeline_current_task_missing",
              reason: "The active task is not present in the pinned task graph."
            })
          );
          return;
        }

        const contextPackPath = await contextPackPathIfExists(
          projectPath,
          task.id,
          pipeline.graphIdentity
        );
        const concurrentWith = readySet(graph, task.id, pipeline.completed);
        const knownFailureModes = await knownFailureModesFor(projectPath, task);
        console.log(buildActionBlock(task, { sessionId: session.id, contextPackPath, concurrentWith, knownFailureModes }));
        await printAndRecordRouting(projectPath, task);
        printWorkflowDirectiveIfAny(graph, pipeline, session.tool, session.id);
        return;
      }

      printLegacyNext(session);
    });
}

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
