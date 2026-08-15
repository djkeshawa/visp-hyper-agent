/**
 * The configured checkpoint: the path taken when Kit owns the workflow.
 *
 * It validates the strict binding first, records evidence and cost, writes the
 * completion memory, and only then renders the next canonical action. The
 * order is the point — evidence must never be attributed to an action that was
 * acquired after the fact.
 */

import { checkContextFreshness } from "../../../context/context-freshness.js";
import { getActiveSession, readState } from "../../../core/session-manager.js";
import { packageVersion } from "../../../core/package-version.js";
import { KitCommandBridge } from "../../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../../kit/kit-availability.js";
import { renderHyperActionFrame, toHyperActionEnvelope } from "../../../kit/workflow-action-renderer.js";
import { aggregateKitCheckpointEvidence, renderKitCheckpointEvidence, unavailableKitCheckpointEvidence } from "../../../quality/kit-checkpoint-evidence.js";
import { escalate } from "../../../routing/routing-engine.js";
import { routingCohortForTask } from "../../../routing/routing-context.js";
import { updateRoutingState } from "../../../routing/routing-state.js";
import { appendAttempt, appendUsage } from "../../../telemetry/telemetry-store.js";
import { hasObservedTokens, reportedUsageNote, unreportedUsageNote, unreportedUsageWarning } from "../../../telemetry/token-usage.js";
import { printWarnings } from "../shared.js";
import { DEFAULT_TIER, predictionForAttempt } from "./attempt-prediction.js";
import { recordCompletionMemory } from "./memory-ledger.js";
import { printRemainingTasks } from "./remaining-tasks.js";
import { readStrictRoutingBinding, routingBindingFromAction, validateStrictCheckpointBinding } from "./strict-binding.js";
import type { StrictRoutingBinding } from "./strict-binding.js";

/**
 * Record what this checkpoint actually knows about the task's token cost.
 *
 * Two outcomes, and only two. If the host reported counts, they go to the
 * local telemetry meter and to Kit's budget ledger as a real row. If nothing
 * was reported, the row is marked unavailable with a note that says the true
 * reason — nothing was handed to this invocation — and the operator is told,
 * out loud, how to supersede it. The old code took the second branch
 * unconditionally with a note claiming observation was impossible, which is
 * why every closed task read as costless.
 *
 * Returns the checklist label to attest, or null when Kit rejected the write.
 */
async function recordCheckpointUsage(
  projectPath: string,
  bridge: KitCommandBridge,
  input: { taskId: string; inputTokens?: number; outputTokens?: number; model?: string }
): Promise<string | null> {
  const { taskId, inputTokens, outputTokens, model } = input;

  if (!hasObservedTokens({ inputTokens, outputTokens })) {
    console.warn(unreportedUsageWarning("visp save", taskId));
    const absent = await bridge.recordBudget({
      taskId,
      unavailable: true,
      note: unreportedUsageNote("visp save", taskId)
    });
    return absent?.success === true ? "record-usage (unavailable)" : null;
  }

  // The local meter is best-effort: a disk failure must not stop the task from
  // closing, and Kit's ledger is the authoritative copy either way.
  try {
    const session = await getActiveSession(projectPath);
    if (session) {
      await appendUsage(projectPath, {
        sessionId: session.id,
        inputTokens,
        outputTokens,
        model
      });
    }
  } catch (error) {
    console.warn(
      `warning: token usage was not recorded to local telemetry: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const recorded = await bridge.recordBudget({
    taskId,
    inputTokens,
    outputTokens,
    model,
    note: reportedUsageNote("visp save")
  });
  return recorded?.success === true ? "record-usage" : null;
}

export async function runConfiguredKitCheckpoint(
  projectPath: string,
  taskId: string,
  actualModel: {
    tier?: string;
    modelId?: string;
    modelVersion?: string;
    acceptWarnings?: boolean;
    inputTokens?: number;
    outputTokens?: number;
  }
): Promise<void> {
  const bridge = new KitCommandBridge({ projectPath });
  const binding = await validateStrictCheckpointBinding(projectPath, taskId);
  if (!binding.ok) {
    const evidence = unavailableKitCheckpointEvidence({
      reasonCode: binding.reasonCode,
      reason: binding.reason
    });
    console.log(
      renderKitCheckpointEvidence({
        taskId,
        evidence,
        contextFreshness: binding.contextFreshness
      })
    );
    const freshAction = await renderFreshCheckpointAction(bridge, taskId);
    if (freshAction.rendered) {
      process.exitCode = 1;
    }
    return;
  }

  const routingBinding = await readStrictRoutingBinding(bridge, taskId);
  const contextFreshness = await checkContextFreshness(projectPath);
  const verify = await bridge.verify(taskId);
  const review = await bridge.review(taskId);
  const blockingFindings =
    contextFreshness.blocking && contextFreshness.finding
      ? [contextFreshness.finding]
      : [];
  const preReconcileEvidence = aggregateKitCheckpointEvidence({
    verify,
    review,
    blockingFindings
  });
  let reconcile: Awaited<ReturnType<KitCommandBridge["reconcile"]>> | undefined;
  const attested: string[] = [];

  if (
    !contextFreshness.blocking &&
    preReconcileEvidence.verifyVerdict === "passed" &&
    preReconcileEvidence.reviewVerdict === "passed"
  ) {
    // The agent's attestation moment — and it must come BEFORE reconcile.
    // Kit's checklist protocol expects the agent to attest read-context /
    // implement-selected-task / scope-check / tests-updated and to record
    // usage via engine commands the thirteen-verb surface does not expose,
    // so a task driven purely through `visp` verbs ended every passing
    // checkpoint stuck at VSP020. Attestation is only recorded once the
    // checkpoint's own verify (which validates scope and runs the validation
    // commands) and review have passed — and reconcile, the step that closes
    // the task, then sees the completed checklist it requires.
    const attestations = [
      {
        item: "read-context",
        evidence: `visp save --task ${taskId}: session context manifest is bound and hash-pinned for this task`
      },
      {
        item: "implement-selected-task",
        evidence: `visp save --task ${taskId}: agent attested completion; checkpoint verify passed`
      },
      {
        item: "scope-check",
        evidence: `visp save --task ${taskId}: Kit verify scope validation passed`
      },
      {
        item: "tests-updated",
        evidence: `visp save --task ${taskId}: Kit verify ran the task's validation commands and passed`
      }
    ];
    for (const attestation of attestations) {
      const updated = await bridge.attestChecklistItem({ taskId, ...attestation });
      if (updated?.success === true) attested.push(attestation.item);
    }
    const usageLabel = await recordCheckpointUsage(projectPath, bridge, {
      taskId,
      inputTokens: actualModel.inputTokens,
      outputTokens: actualModel.outputTokens,
      model: actualModel.modelId
    });
    if (usageLabel !== null) attested.push(usageLabel);

    reconcile = await bridge.reconcile(taskId, {
      acceptWarnings: actualModel.acceptWarnings === true
    });

    // Memory accrues from the work itself, not from agent discipline. Agents
    // were TOLD to run `visp learn`, and mostly did not — so on the next
    // feature the store held nothing and every run re-discovered the project
    // from scratch. A verified checkpoint is a mechanical fact the
    // coordinator witnessed (like the git history `visp-memory init` seeds
    // from), so it is recorded directly as episodic memory, compact enough
    // that recalling it later costs a few dozen tokens, not a re-read.
    await recordCompletionMemory(projectPath, taskId);
  }

  const evidence = aggregateKitCheckpointEvidence({
    verify,
    review,
    reconcile,
    blockingFindings
  });
  if (routingBinding && actualModel.modelId && actualModel.modelVersion) {
    const session = await getActiveSession(projectPath);
    if (session) {
      try {
        const cohort = routingCohortForTask({
          host: session.tool,
          task: routingBinding.task,
          modelId: actualModel.modelId,
          modelVersion: actualModel.modelVersion
        });
        const strictPrediction = await predictionForAttempt({
          projectPath,
          task: { ...routingBinding.task, id: taskId },
          cohort,
          tierUsed: actualModel.tier ?? DEFAULT_TIER
        });
        await appendAttempt(projectPath, {
          taskId,
          featureId: routingBinding.featureId,
          workItemKey: `${routingBinding.featureId}:${taskId}`,
          prediction: strictPrediction,
          taskClass: routingBinding.task.taskClass,
          riskLevel: routingBinding.task.riskLevel,
          riskFactors:
            routingBinding.task.riskFactors === null
              ? null
              : [...routingBinding.task.riskFactors],
          assuranceProfile: routingBinding.task.assuranceProfile,
          host: session.tool,
          modelId: actualModel.modelId,
          modelVersion: actualModel.modelVersion,
          projectPreset: cohort.projectPreset,
          protocolVersion: routingBinding.protocolVersion,
          kitVersion: routingBinding.kitVersion,
          hyperVersion: packageVersion(),
          tier: actualModel.tier ?? DEFAULT_TIER,
          verifyPassed: evidence.verifyVerdict === "passed",
          reviewPassed: evidence.reviewVerdict === "passed",
          verdict: evidence.verdict,
          evidenceSource: "kit",
          sessionId: session.id
        });
      } catch (error) {
        console.log(
          `warning: strict Kit telemetry attempt was not recorded: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  printWarnings(bridge.warnings);
  console.log(
    renderKitCheckpointEvidence({
      taskId,
      evidence,
      contextFreshness: contextFreshness.status,
      warnings: contextFreshness.warnings
    })
  );
  if (attested.length > 0) {
    console.log(`attested: ${attested.join(", ")}`);
  }
  // Two surfaces must not tell different stories: save used to print PASSED
  // while reconcile — passing WITH WARNINGS — deliberately left the task
  // open, and nothing said so. Kit's conservatism stands; the reader learns
  // about it here, with the one decision that closes the task.
  if (
    evidence.verdict === "passed" &&
    reconcile?.result === "warnings" &&
    actualModel.acceptWarnings !== true
  ) {
    console.log(
      `task_status: still open — reconcile passed with warnings, and accepting them is a human call. Review the warnings, then close with: visp save --task ${taskId} --accept-warnings`
    );
  }
  if (evidence.verdict === "passed") {
    await printRemainingTasks(projectPath, taskId);
  }
  const freshAction = await renderFreshCheckpointAction(bridge, taskId);
  if (routingBinding && evidence.verdict === "failed") {
    try {
      const hyperState = await readState(projectPath);
      await updateRoutingState(projectPath, (state) =>
        escalate({
          state,
          taskId,
          taskClass: routingBinding.task.taskClass,
          riskLevel: routingBinding.task.riskLevel,
          riskFactors: routingBinding.task.riskFactors,
          sessionCount: Object.keys(hyperState.sessions).length,
          now: new Date().toISOString()
        })
      );
    } catch (error) {
      console.log(
        `warning: strict Kit routing quarantine was not recorded: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (freshAction.rendered) {
    process.exitCode = evidence.verdict === "passed" ? 0 : 1;
  }
}

type FreshCheckpointAction = {
  rendered: boolean;
  routingBinding: StrictRoutingBinding | null;
};

async function renderFreshCheckpointAction(
  bridge: KitCommandBridge,
  taskId: string
): Promise<FreshCheckpointAction> {
  const contractDiagnostic = await bridge.integrationContractDiagnostic();
  if (!contractDiagnostic.ok) {
    console.log("");
    console.log(
      renderKitAuthorityStop({
        status: "INCONCLUSIVE",
        reasonCode: contractDiagnostic.reasonCode,
        reason: contractDiagnostic.reason
      })
    );
    process.exitCode = 1;
    return { rendered: false, routingBinding: null };
  }

  const actionDiagnostic = await bridge.nextCanonicalActionDiagnostic(
    "auto",
    contractDiagnostic.value
  );
  if (!actionDiagnostic.ok) {
    console.log("");
    console.log(
      renderKitAuthorityStop({
        status: "INCONCLUSIVE",
        reasonCode: actionDiagnostic.reasonCode,
        reason: actionDiagnostic.reason
      })
    );
    process.exitCode = 1;
    return { rendered: false, routingBinding: null };
  }

  console.log("");
  console.log(
    renderHyperActionFrame(toHyperActionEnvelope(actionDiagnostic.value))
  );
  return {
    rendered: true,
    routingBinding: routingBindingFromAction(
      actionDiagnostic.value,
      contractDiagnostic.value.kit.version,
      taskId
    )
  };
}
