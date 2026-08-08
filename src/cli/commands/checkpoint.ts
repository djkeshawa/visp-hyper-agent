import { Command, Option } from "commander";
import { join, posix, win32 } from "node:path";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { GitBranchSessionLocator } from "../../core/branch-session-locator.js";
import { gitOutput } from "../../core/git.js";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import { packageVersion } from "../../core/package-version.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import type { NormalizedWorkflowAction } from "../../kit/workflow-action-adapter.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../kit/workflow-action-renderer.js";
import { recordFailurePattern } from "../../memory/failure-patterns.js";
import { createCheckpointSnapshot, writeCheckpointSnapshot } from "../../quality/checkpoint-snapshot.js";
import {
  aggregateKitCheckpointEvidence,
  renderKitCheckpointEvidence,
  unavailableKitCheckpointEvidence
} from "../../quality/kit-checkpoint-evidence.js";
import { collectLocalEvidence } from "../../quality/local-evidence.js";
import { harvestSkillProposals } from "./remember.js";
import {
  applyAdaptiveDecision,
  decideAdaptiveAction,
  failureFingerprint,
  effectiveGraph,
  renderAdaptationBlock,
  type AdaptiveDecision
} from "../../pipeline/adaptive-rules.js";
import { advance, buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import {
  computeSuggestedTier,
  escalate,
  predictionFromSuggestion,
  renderModelRouting
} from "../../routing/routing-engine.js";
import {
  defaultModelId,
  routingCohortForTask,
  routingTaskFromAction,
  type RoutingTaskDescriptor
} from "../../routing/routing-context.js";
import {
  readRoutingState,
  updateRoutingState
} from "../../routing/routing-state.js";
import {
  appendAttempt,
  readTelemetry,
  type AttemptPrediction
} from "../../telemetry/telemetry-store.js";
import { printWarnings, printWorkflowDirectiveIfAny, resolveProjectPath } from "./shared.js";
import { collectChangedFiles } from "../../governance/scope-guard.js";
import type { EvidenceVerdict } from "../../core/types.js";

// Default tier recorded in telemetry when the orchestrator does not report
// which tier actually executed the task via `--tier`.
const DEFAULT_TIER = "implementer";

/**
 * Compute the calibration prediction for an attempt about to be recorded (P8-01).
 *
 * Reads telemetry BEFORE the append, so the prediction cannot see its own
 * outcome — a prediction that can is trivially well calibrated and worthless.
 *
 * Returns null when routing cannot be computed. An absent prediction is recorded
 * honestly as un-calibratable; it is never invented after the fact, which is the
 * failure calibration exists to detect.
 *
 * Observational only: it never changes a routing decision and never widens what
 * an action may touch.
 */
async function predictionForAttempt(input: {
  projectPath: string;
  task: Parameters<typeof computeSuggestedTier>[0]["task"];
  cohort: Parameters<typeof computeSuggestedTier>[0]["cohort"];
  tierUsed: string;
}): Promise<AttemptPrediction | null> {
  try {
    const { data: telemetry } = await readTelemetry(input.projectPath);
    const { state: routingState } = await readRoutingState(input.projectPath);
    const hyperState = await readState(input.projectPath);
    const suggestion = computeSuggestedTier({
      task: input.task,
      cohort: input.cohort,
      attempts: telemetry.attempts,
      routingState,
      sessionCount: Object.keys(hyperState.sessions).length
    });
    return predictionFromSuggestion(suggestion, input.tierUsed);
  } catch {
    return null;
  }
}

export function checkpointCommand(): Command {
  return new Command("checkpoint")
    .description("Capture current progress and git diff summary.")
    .addOption(new Option("--task <task-id>", "Run pipeline verify/review for the active task and advance the pipeline."))
    .addOption(
      new Option(
        "--accept-warnings",
        "Close the task even when reconcile passes with warnings (a deliberate human call)."
      )
    )
    .addOption(new Option("--tier <tier>", "Model tier that actually executed the task (recorded in telemetry)."))
    .addOption(new Option("--model <model-id>", "Model ID that actually executed the task (recorded in telemetry)."))
    .addOption(new Option("--model-version <version>", "Model version that actually executed the task (recorded in telemetry)."))
    .action(async function (
      this: Command,
      options: {
        task?: string;
        acceptWarnings?: boolean;
        tier?: string;
        model?: string;
        modelVersion?: string;
      }
    ) {
      const projectPath = resolveProjectPath(this);
      if (!options.task) {
        const session = await getActiveSession(projectPath);
        if (!session) {
          throw new Error("No active Visp Hyper session. Run `visp work <goal>` first.");
        }
        await writeCheckpointMarkdown(projectPath, session.id, session.goal);
        console.log("Checkpoint written to .visp/hyper/current/checkpoints.md");
        return;
      }

      const taskId = options.task;
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        const contextFreshness = await checkContextFreshness(projectPath);
        printWarnings(kit.warnings);
        console.log(
          renderKitCheckpointEvidence({
            taskId,
            evidence: unavailableKitCheckpointEvidence({
              reasonCode: kit.reasonCode,
              reason: kit.reason
            }),
            contextFreshness: contextFreshness.status,
            warnings: contextFreshness.warnings
          })
        );
        process.exitCode = 1;
        return;
      }
      if (kit.state === "healthy") {
        await runConfiguredKitCheckpoint(projectPath, taskId, {
          tier: options.tier,
          modelId: options.model,
          modelVersion: options.modelVersion,
          acceptWarnings: options.acceptWarnings === true
        });
        return;
      }

      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp work <goal>` first.");
      }
      const contextFreshness = await checkContextFreshness(projectPath);

      await writeCheckpointMarkdown(projectPath, session.id, session.goal, taskId);

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
      const baseGraph =
        (await loadTaskGraph(projectPath)) ??
        (syntheticTasks && syntheticTasks.length > 0 ? { tasks: syntheticTasks } : null);
      const graph = baseGraph ? effectiveGraph(baseGraph, session.pipeline) : null;
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
      const taskClass = task?.taskClass ?? null;
      const riskLevel = task?.riskLevel ?? null;
      const riskFactors = task?.riskFactors ?? null;
      const assuranceProfile = task?.assuranceProfile ?? null;

      // Only a genuinely Kit-absent project may use Hyper's local_checked path.
      const localConfig = await readConfig(projectPath);
      const evidence = await collectLocalEvidence({
        projectPath,
        task: {
          id: taskId,
          allowedFiles: task?.allowedFiles,
          validationCommands: task?.validationCommands
        },
        blockedPaths: localConfig.blockedPaths,
        configValidationCommands: localConfig.validationCommands
      });
      const verifyPassed = evidence.verifyPassed;
      let reviewPassed = evidence.reviewPassed;
      const verifyVerdict = evidence.verifyVerdict;
      let reviewVerdict = evidence.reviewVerdict;
      const assuranceLevel = evidence.assuranceLevel;
      let localFindings = evidence.findings;
      const evidenceSource = "local" as const;
      let failureFindings = localFindings;
      printWarnings([...kit.warnings, ...evidence.warnings]);
      if (contextFreshness.blocking) {
        reviewPassed = false;
        reviewVerdict = "failed";
        failureFindings = [
          ...failureFindings,
          contextFreshness.finding ?? "context freshness check failed"
        ];
        localFindings = [...localFindings, contextFreshness.finding ?? "context freshness check failed"];
      }

      const verdict: EvidenceVerdict = verifyVerdict === "failed" || reviewVerdict === "failed"
        ? "failed"
        : verifyVerdict === "inconclusive" || reviewVerdict === "inconclusive"
          ? "inconclusive"
          : "passed";
      const passed = verdict === "passed";
      const tier = options.tier ?? DEFAULT_TIER;
      const routingCohort = routingCohortForTask({
        host: session.tool,
        task: task ?? {},
        assuranceProfile,
        modelId: options.model ?? defaultModelId(session.tool, tier),
        modelVersion: options.modelVersion ?? null
      });
      const localPrediction = await predictionForAttempt({
        projectPath,
        task: { id: taskId, taskClass, riskLevel, riskFactors, assuranceProfile },
        cohort: routingCohort,
        tierUsed: tier
      });
      try {
        await appendAttempt(projectPath, {
          taskId,
          taskClass,
          riskLevel,
          riskFactors,
          assuranceProfile,
          prediction: localPrediction,
          host: routingCohort.host,
          modelId: routingCohort.modelId,
          modelVersion: routingCohort.modelVersion,
          projectPreset: routingCohort.projectPreset,
          protocolVersion: "local-checked/1.0",
          kitVersion: "none",
          hyperVersion: packageVersion(),
          tier,
          verifyPassed,
          reviewPassed,
          verdict,
          evidenceSource,
          sessionId: session.id
        });
      } catch (error) {
        console.log(`warning: telemetry attempt was not recorded: ${error instanceof Error ? error.message : String(error)}`);
      }

      const nextState = advance(
        session.pipeline!,
        graph,
        {
          verifyPassed,
          reviewPassed,
          detail: `${evidenceSource}-evidence`,
          // P8-03: recorded on failure so a later identical failure can be
          // recognised and escalated instead of retried.
          ...(verdict === "failed" ? { failureFingerprint: failureFingerprint(failureFindings) } : {})
        },
        new Date().toISOString()
      );
      await updateActiveSession(projectPath, (current) => ({ ...current, pipeline: nextState }));

      let adaptiveDecision: AdaptiveDecision = { action: "none" };
      if (verdict === "failed" && task) {
        try {
          adaptiveDecision = decideAdaptiveAction({ state: nextState, task, findings: failureFindings });
          if (adaptiveDecision.action !== "none") {
            const adapted = applyAdaptiveDecision(nextState, adaptiveDecision, taskId, new Date().toISOString());
            await updateActiveSession(projectPath, (current) => ({ ...current, pipeline: adapted }));
          }
        } catch (error) {
          adaptiveDecision = { action: "none" };
          console.log(`warning: pipeline adaptation was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Quality recovers unconditionally: a checkpoint failure quarantines the
      // task class so future routing forces the strongest tier until it expires.
      if (verdict === "failed") {
        try {
          const hyperState = await readState(projectPath);
          await updateRoutingState(projectPath, (state) => escalate({
            state,
            taskId,
            taskClass,
            riskLevel,
            riskFactors,
            sessionCount: Object.keys(hyperState.sessions).length,
            now: new Date().toISOString()
          }));
        } catch (error) {
          console.log(`warning: routing escalation was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }

        try {
          const diff = await collectChangedFiles(projectPath, { mode: "all" });
          const relatedFiles = [
            ...diff.files,
            ...(task?.allowedFiles ?? []),
            ...(task?.expectedFiles ?? [])
          ];
          await recordFailurePattern(projectPath, {
            taskId,
            taskClass: taskClass ?? "unknown",
            sessionId: session.id,
            source: evidenceSource,
            verifyPassed,
            reviewPassed,
            findings: failureFindings.length > 0 ? failureFindings : ["checkpoint failed without detailed findings"],
            relatedFiles
          });
        } catch (error) {
          console.log(`warning: failure pattern was not recorded: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const lines = [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        `task: ${taskId}`,
        `verify: ${verifyVerdict.toUpperCase()}`,
        `review: ${reviewVerdict.toUpperCase()}`,
        `verdict: ${verdict.toUpperCase()}`,
        `assurance_level: ${assuranceLevel}`,
        `evidence_source: ${evidenceSource}`,
        `context_freshness: ${contextFreshness.status}`
      ];
      if (contextFreshness.warnings.length > 0) {
        lines.push("warnings:");
        for (const warning of contextFreshness.warnings) {
          lines.push(` - ${warning}`);
        }
      }
      const visibleFindings = evidenceSource === "local" ? localFindings : failureFindings;
      if (visibleFindings.length > 0 && !passed) {
        lines.push("findings:");
        for (const finding of visibleFindings) {
          lines.push(` - ${finding}`);
        }
      }
      lines.push(`status: ${verdict.toUpperCase()}`);
      if (passed) {
        if (nextState.currentTaskId) {
          lines.push(`next_task: ${nextState.currentTaskId}`);
        } else {
          lines.push("pipeline_complete: true");
        }
      } else if (verdict === "failed") {
        lines.push(`instruction: Fix the reported findings and re-run checkpoint --task ${taskId}.`);
      } else {
        lines.push(`instruction: Restore the missing evidence and re-run checkpoint --task ${taskId}.`);
      }
      lines.push("END_VISP_CHECKPOINT_RESULT");
      console.log(lines.join("\n"));

      const adaptationBlock = renderAdaptationBlock(taskId, adaptiveDecision);
      if (adaptationBlock) {
        console.log("");
        console.log(adaptationBlock);
        if (adaptiveDecision.action === "inject-remediation") {
          console.log("");
          console.log(buildActionBlock(adaptiveDecision.remediationTask, { sessionId: session.id }));
        }
      }

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
              cohort: routingCohortForTask({
                host: session.tool,
                task: nextTask
              }),
              attempts: telemetry.attempts,
              routingState,
              sessionCount: Object.keys(hyperState.sessions).length
            });
            console.log("");
            console.log(renderModelRouting(suggestion));
          } catch {
            // Advisory only; never fail the checkpoint because routing could not be computed.
          }
          printWorkflowDirectiveIfAny(graph, nextState, session.tool, session.id);
        }
      }

      const config = await readConfig(projectPath);
      const harvest = await harvestSkillProposals(projectPath, config, session);
      for (const line of harvest.lines) {
        console.log(line);
      }
    });
}

/**
 * Format the compact completion memory for a verified task. Pure so the
 * shape — one line, capped, no artifact dumps — is pinned by a unit test:
 * memory that costs more tokens to recall than it saves is worse than none.
 */
export function taskCompletionMemory(input: {
  readonly taskId: string;
  readonly goal: string;
  readonly changedFiles: readonly string[];
}): string {
  const files = input.changedFiles.slice(0, 5).join(", ");
  const more = input.changedFiles.length > 5 ? ` (+${input.changedFiles.length - 5} more)` : "";
  const goal = input.goal.length > 160 ? `${input.goal.slice(0, 159)}…` : input.goal;
  return `Verified ${input.taskId}: ${goal}${files.length > 0 ? ` — files: ${files}${more}` : ""}`;
}

/**
 * Format one plan decision as a memory. Pure and capped for the same reason
 * as the completion line: decisions carry the domain vocabulary future goals
 * actually share ("overdue", "YYYY-MM-DD", file names) — the completion lines
 * alone described implementation minutiae and never matched the next
 * feature's goal in evaluation.
 */
export function decisionMemoryLine(input: {
  readonly featureKey: string;
  readonly id: string;
  readonly title: string;
  readonly decision: string;
}): string {
  const body = `${input.title} — ${input.decision}`;
  const capped = body.length > 220 ? `${body.slice(0, 219)}…` : body;
  return `Decision ${input.id} (${input.featureKey}): ${capped}`;
}

const memoryLedgerPath = (projectPath: string): string =>
  vispPath(projectPath, "hyper", "memory-ledger.json");

async function recordCompletionMemory(projectPath: string, taskId: string): Promise<void> {
  try {
    const config = await readConfig(projectPath);
    if (config.memoryMode !== "llm-memory") return;
    const { resolveExecutable, execFileResolved } = await import(
      "../../core/executable-resolver.js"
    );
    if ((await resolveExecutable("visp-memory")) === null) return;
    const record = async (content: string, category: string, importance: string) =>
      execFileResolved(
        "visp-memory",
        ["record", content, "--category", category, "--importance", importance],
        { cwd: projectPath, timeout: 30_000 }
      );

    const session = await getActiveSession(projectPath);
    const diff = await collectChangedFiles(projectPath, { mode: "all" });
    await record(
      taskCompletionMemory({
        taskId,
        goal: session?.goal ?? "task goal unavailable",
        changedFiles: diff.files
      }),
      "task-completion",
      "0.6"
    );
    const remembered = ["task completion"];

    // The feature's accepted decisions, once each (a multi-task feature saves
    // several times; the ledger keeps re-saves from duplicating them).
    const decisions = await unrecordedPlanDecisions(projectPath);
    for (const decision of decisions) {
      await record(decision.line, "decision", "0.7");
    }
    if (decisions.length > 0) {
      remembered.push(`${decisions.length} plan decision(s)`);
      await markDecisionsRecorded(
        projectPath,
        decisions.map((decision) => decision.key)
      );
    }
    console.log(`remembered: ${remembered.join(", ")} recorded for future recall`);
  } catch (error) {
    console.log(
      `warning: memory was not recorded: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function unrecordedPlanDecisions(
  projectPath: string
): Promise<Array<{ key: string; line: string }>> {
  const statusText = await readTextIfExists(join(projectPath, ".visp", "status.json"));
  if (!statusText) return [];
  const status = JSON.parse(statusText) as { activeFeaturePath?: string };
  if (typeof status.activeFeaturePath !== "string") return [];
  const featureKey = status.activeFeaturePath.split("/").at(-1) ?? "feature";
  const planText = await readTextIfExists(
    join(projectPath, status.activeFeaturePath, "plan.json")
  );
  if (!planText) return [];
  const plan = JSON.parse(planText) as {
    decisions?: Array<{ id?: string; title?: string; decision?: string }>;
  };
  const ledgerText = await readTextIfExists(memoryLedgerPath(projectPath));
  const ledger = (ledgerText ? JSON.parse(ledgerText) : { decisions: [] }) as {
    decisions: string[];
  };
  const recorded = new Set(ledger.decisions ?? []);
  return (plan.decisions ?? [])
    .filter(
      (decision): decision is { id: string; title: string; decision: string } =>
        typeof decision.id === "string" &&
        typeof decision.title === "string" &&
        typeof decision.decision === "string"
    )
    .map((decision) => ({
      key: `${featureKey}:${decision.id}`,
      line: decisionMemoryLine({ featureKey, ...decision })
    }))
    .filter((decision) => !recorded.has(decision.key));
}

async function markDecisionsRecorded(projectPath: string, keys: readonly string[]): Promise<void> {
  const ledgerText = await readTextIfExists(memoryLedgerPath(projectPath));
  const ledger = (ledgerText ? JSON.parse(ledgerText) : { decisions: [] }) as {
    decisions: string[];
  };
  ledger.decisions = [...new Set([...(ledger.decisions ?? []), ...keys])];
  await writeText(memoryLedgerPath(projectPath), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * The cadence line: what this feature still owes after a save.
 *
 * Six evaluation rounds showed the same drift — the agent closes ONE task,
 * then batches the rest without saves, leaving implemented work forever
 * `pending`. Naming the remaining tasks at the exact moment a save succeeds
 * is the pull-back: the reader finishes one loop and is immediately handed
 * the next. Pure so the shape (short, capped, names not ids alone) is
 * pinned by a unit test.
 */
export function remainingTasksLine(
  tasks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>,
  justSavedId: string
): string | null {
  const remaining = tasks.filter(
    (task) =>
      task.id !== justSavedId && task.status !== "done" && task.status !== "verified"
  );
  if (remaining.length === 0) return null;
  const shown = remaining
    .slice(0, 4)
    .map((task) => `${task.id} (${task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title})`);
  const more = remaining.length > 4 ? ` (+${remaining.length - 4} more)` : "";
  return `remaining in this feature: ${shown.join(", ")}${more} — repeat plan → work → save for each`;
}

async function printRemainingTasks(projectPath: string, justSavedId: string): Promise<void> {
  try {
    const statusText = await readTextIfExists(join(projectPath, ".visp", "status.json"));
    if (!statusText) return;
    const status = JSON.parse(statusText) as { activeFeaturePath?: string };
    if (typeof status.activeFeaturePath !== "string") return;
    const graphText = await readTextIfExists(
      join(projectPath, status.activeFeaturePath, "task-graph.json")
    );
    if (!graphText) return;
    const graph = JSON.parse(graphText) as {
      tasks?: Array<{ id?: string; title?: string; status?: string }>;
    };
    const tasks = (graph.tasks ?? []).filter(
      (task): task is { id: string; title: string; status: string } =>
        typeof task.id === "string" && typeof task.title === "string" && typeof task.status === "string"
    );
    const line = remainingTasksLine(tasks, justSavedId);
    if (line !== null) console.log(line);
  } catch {
    // The cadence line is advisory; a malformed artifact must not fail a save.
  }
}

async function runConfiguredKitCheckpoint(
  projectPath: string,
  taskId: string,
  actualModel: {
    tier?: string;
    modelId?: string;
    modelVersion?: string;
    acceptWarnings?: boolean;
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
    const usage = await bridge.recordBudget({
      taskId,
      unavailable: true,
      note: "visp save: the coordinator cannot observe the agent's token usage"
    });
    if (usage?.success === true) attested.push("record-usage (unavailable)");

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

type StrictCheckpointBinding =
  | { ok: true }
  | {
      ok: false;
      reasonCode: "strict_session_unavailable" | "strict_session_binding_unavailable";
      reason: string;
      contextFreshness: "untracked" | "missing" | "error";
    };

const strictSessionLocator = new GitBranchSessionLocator();

async function validateStrictCheckpointBinding(
  projectPath: string,
  taskId: string
): Promise<StrictCheckpointBinding> {
  let stateText: string | undefined;
  try {
    stateText = await readTextIfExists(vispPath(projectPath, "hyper", "state.json"));
  } catch {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state could not be read.",
      "untracked"
    );
  }
  if (!stateText) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "No active Hyper session state exists for this configured checkpoint.",
      "untracked"
    );
  }

  let state: unknown;
  try {
    state = JSON.parse(stateText) as unknown;
  } catch {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state is unreadable.",
      "untracked"
    );
  }
  if (!isRecord(state) || !isRecord(state.sessions)) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state is malformed.",
      "untracked"
    );
  }

  const branch = await strictSessionLocator.currentBranch(projectPath);
  const branchKey = strictSessionLocator.sessionKey(projectPath, branch);
  const branchSessionId = isRecord(state.activeSessionByBranch) &&
      typeof state.activeSessionByBranch[branchKey] === "string" &&
      isRecord(state.sessions[state.activeSessionByBranch[branchKey]])
    ? state.activeSessionByBranch[branchKey]
    : undefined;
  const fallbackSessionId = typeof state.activeSessionId === "string" &&
      isRecord(state.sessions[state.activeSessionId])
    ? state.activeSessionId
    : undefined;
  const sessionId = branchSessionId ?? fallbackSessionId;
  const session = sessionId ? state.sessions[sessionId] : undefined;
  if (!sessionId || !isRecord(session) || session.id !== sessionId) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "No coherent active Hyper session exists for this configured checkpoint.",
      "untracked"
    );
  }
  if (!isNonEmptyString(session.goal) || session.projectPath !== projectPath) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The active Hyper session is not bound to this project and goal.",
      "error"
    );
  }

  let manifestText: string | undefined;
  try {
    manifestText = await readTextIfExists(
      vispPath(projectPath, "hyper", "current", "context-manifest.json")
    );
  } catch {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest could not be read.",
      "error"
    );
  }
  if (!manifestText) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is missing.",
      "missing"
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is unreadable.",
      "error"
    );
  }
  if (!isRecord(manifest)) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is malformed.",
      "error"
    );
  }
  if (manifest.sessionId !== sessionId) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the active session ID.",
      "error"
    );
  }
  if (manifest.taskId !== taskId) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the requested task ID. Re-run `visp work \"<goal>\"` to rebind the session to the task Kit currently selects.",
      "error"
    );
  }
  if (manifest.goal !== session.goal) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the active session goal.",
      "error"
    );
  }

  const bindingIssue = kitManifestBindingIssue(manifest);
  if (bindingIssue) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      bindingIssue,
      "error"
    );
  }
  return { ok: true };
}

type StrictRoutingBinding = {
  featureId: string;
  task: RoutingTaskDescriptor;
  protocolVersion: string;
  kitVersion: string;
};

async function readStrictRoutingBinding(
  bridge: KitCommandBridge,
  taskId: string
): Promise<StrictRoutingBinding | null> {
  const contract = await bridge.integrationContractDiagnostic();
  if (!contract.ok) {
    return null;
  }
  const action = await bridge.nextCanonicalActionDiagnostic("auto", contract.value);
  if (!action.ok || action.value.verdict !== "ready") return null;
  return routingBindingFromAction(action.value, contract.value.kit.version, taskId);
}

function routingBindingFromAction(
  action: NormalizedWorkflowAction,
  kitVersion: string,
  taskId: string
): StrictRoutingBinding | null {
  if (
    action.task?.id !== taskId ||
    action.feature.state !== "available" ||
    action.feature.value === null
  ) return null;
  const task = routingTaskFromAction(action);
  if (!task) return null;
  return {
    featureId: action.feature.value.id,
    task,
    protocolVersion: action.source.protocolVersion,
    kitVersion
  };
}

function kitManifestBindingIssue(manifest: Record<string, unknown>): string | undefined {
  const contextArtifact = pinnedArtifact(manifest.contextArtifact);
  if (!contextArtifact) {
    return "The current context manifest has no valid Kit context artifact binding.";
  }

  if (!Array.isArray(manifest.artifactProvenance) || manifest.artifactProvenance.length === 0) {
    return "The current context manifest has no Kit artifact provenance binding.";
  }
  const provenance = manifest.artifactProvenance.map((value) => kitProvenanceArtifact(value));
  if (provenance.some((value) => value === null)) {
    return "The current context manifest has malformed Kit artifact provenance.";
  }
  const pinnedProvenance = provenance.filter(
    (value): value is { path: string; hash: string } => value !== null
  );
  if (hasDuplicateArtifactPath(pinnedProvenance)) {
    return "The current context manifest has duplicate or conflicting Kit artifact provenance paths.";
  }

  if (!isRecord(manifest.kitReadContract)) {
    return "The current context manifest has no Kit read contract binding.";
  }
  const readContract = manifest.kitReadContract;
  if (
    readContract.contractVersion !== "2.0" ||
    readContract.readContractVersion !== "0.1" ||
    !Array.isArray(readContract.requiredArtifacts) ||
    readContract.requiredArtifacts.length === 0
  ) {
    return "The current context manifest has an incomplete Kit read contract binding.";
  }
  if (
    !isRecord(readContract.freshnessPolicy) ||
    readContract.freshnessPolicy.contextPackHashPinned !== true ||
    readContract.freshnessPolicy.provenanceArtifactsHashPinned !== true ||
    !Array.isArray(readContract.freshnessPolicy.staleContextBlocks) ||
    !readContract.freshnessPolicy.staleContextBlocks.every(isNonEmptyString) ||
    !readContract.freshnessPolicy.staleContextBlocks.includes("checkpoint")
  ) {
    return "The current context manifest has an incomplete Kit freshness-policy binding.";
  }
  const requiredArtifacts = readContract.requiredArtifacts.map((value) => requiredKitArtifact(value));
  if (requiredArtifacts.some((value) => value === null)) {
    return "The current context manifest has malformed Kit required-artifact bindings.";
  }
  const boundArtifacts = requiredArtifacts.filter(
    (value): value is RequiredKitArtifact =>
      value !== null
  );
  const checkpointArtifacts = boundArtifacts.filter((artifact) =>
    artifact.requiredFor.includes("checkpoint")
  );
  if (hasDuplicateArtifactPath(checkpointArtifacts)) {
    return "The current context manifest has duplicate or conflicting Kit checkpoint read paths.";
  }
  if (checkpointArtifacts.some((artifact) => artifact.freshness !== "hash-pinned")) {
    return "The current context manifest has a checkpoint read that is not hash-pinned.";
  }
  const taskGraphArtifacts = checkpointArtifacts.filter(
    (artifact) => artifact.role === "task-graph"
  );
  const contextPackArtifacts = checkpointArtifacts.filter(
    (artifact) => artifact.role === "context-pack"
  );
  if (
    taskGraphArtifacts.length !== 1 ||
    taskGraphArtifacts[0].mimeType !== "application/json" ||
    contextPackArtifacts.length !== 1 ||
    contextPackArtifacts[0].mimeType !== "application/json"
  ) {
    return "The current context manifest must bind one JSON task graph and one JSON context pack for checkpoint.";
  }
  if (
    !pinnedProvenance.some(
      (artifact) =>
        artifact.path === contextArtifact.path && artifact.hash === contextArtifact.hash
    )
  ) {
    return "The Kit context artifact is not bound to its pinned provenance.";
  }
  if (
    contextPackArtifacts[0].path !== contextArtifact.path
  ) {
    return "The Kit context artifact is not bound to a checkpoint read requirement.";
  }
  const unpinnedCheckpointArtifact = checkpointArtifacts.find(
    (artifact) => !pinnedProvenance.some((provenance) => provenance.path === artifact.path)
  );
  if (unpinnedCheckpointArtifact) {
    return `The Kit checkpoint read artifact is not bound to pinned provenance: ${unpinnedCheckpointArtifact.path}.`;
  }
  return undefined;
}

function pinnedArtifact(value: unknown): { path: string; hash: string } | null {
  if (!isRecord(value)) return null;
  const path = normalizedArtifactPath(value.path);
  return path && isSha256(value.hash) && value.hashAlgorithm === "sha256"
    ? { path, hash: value.hash }
    : null;
}

function kitProvenanceArtifact(value: unknown): { path: string; hash: string } | null {
  if (!isRecord(value) || value.source !== "visp-kit") return null;
  return pinnedArtifact(value);
}

type RequiredKitArtifact = {
  path: string;
  role: string;
  mimeType: string;
  requiredFor: string[];
  freshness: string;
};

function requiredKitArtifact(value: unknown): RequiredKitArtifact | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.role) ||
    !isNonEmptyString(value.mimeType) ||
    !isNonEmptyString(value.freshness) ||
    !Array.isArray(value.requiredFor) ||
    !value.requiredFor.every(isNonEmptyString)
  ) {
    return null;
  }
  const path = normalizedArtifactPath(value.path);
  return path
    ? {
        path,
        role: value.role,
        mimeType: value.mimeType,
        requiredFor: value.requiredFor,
        freshness: value.freshness
      }
    : null;
}

function normalizedArtifactPath(value: unknown): string | null {
  if (!isNonEmptyString(value) || value !== value.trim()) return null;
  if (
    /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    /^[a-z]:/iu.test(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    return null;
  }
  const normalized = posix.normalize(value);
  return normalized === "." || normalized.endsWith("/") || normalized !== value
    ? null
    : normalized;
}

function hasDuplicateArtifactPath(values: Array<{ path: string }>): boolean {
  const paths = new Set<string>();
  for (const value of values) {
    if (paths.has(value.path)) return true;
    paths.add(value.path);
  }
  return false;
}

function strictBindingFailure(
  reasonCode: "strict_session_unavailable" | "strict_session_binding_unavailable",
  reason: string,
  contextFreshness: "untracked" | "missing" | "error"
): StrictCheckpointBinding {
  return { ok: false, reasonCode, reason, contextFreshness };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function writeCheckpointMarkdown(
  projectPath: string,
  sessionId: string,
  goal: string,
  taskId?: string
): Promise<void> {
  // A project with no commits yet has no resolvable HEAD. That is an ordinary
  // first-run state, so the diff stat degrades to a note instead of throwing
  // out of the whole checkpoint.
  const [stat, snapshot] = await Promise.all([
    gitOutput(projectPath, ["diff", "--stat", "HEAD"]),
    createCheckpointSnapshot(projectPath, { sessionId, goal, taskId })
  ]);
  const diffStat = stat.ok
    ? stat.stdout.trim() || "_No diff._"
    : `_Diff stat unavailable: ${stat.reason}._`;
  const files = snapshot.files.map((file) => file.path);
  const content = [
    `## Checkpoint ${snapshot.checkpointAt}`,
    "",
    `Session: ${sessionId}`,
    `Goal: ${goal}`,
    ...(taskId ? [`Task: ${taskId}`] : []),
    "",
    "## Git Diff Stat",
    "",
    diffStat,
    "",
    "## Changed Files",
    "",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["_No changed files._"]),
    ...(snapshot.warnings.length > 0
      ? [
          "",
          "## Snapshot Warnings",
          "",
          ...snapshot.warnings.map((warning) => `- ${warning}`)
        ]
      : []),
    ""
  ].join("\n");
  const path = vispPath(projectPath, "hyper", "current", "checkpoints.md");
  const previous = await readTextIfExists(path);
  await writeText(path, previous ? `${previous.trimEnd()}\n\n${content}` : `# Checkpoints\n\n${content}`);
  await writeCheckpointSnapshot(projectPath, snapshot);
}
