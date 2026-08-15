/**
 * `visp save`: record a checkpoint of the current work.
 *
 * This file owns the command surface and the local (Kit-less) path. The
 * configured Kit path, the strict binding it depends on, the memory ledger,
 * and the record written to disk each live in `./checkpoint/`.
 */

import { Command, Option } from "commander";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import { packageVersion } from "../../core/package-version.js";
import { detectVisp } from "../../kit/kit-command-bridge.js";
import { recordFailurePattern } from "../../memory/failure-patterns.js";
import { renderKitCheckpointEvidence, unavailableKitCheckpointEvidence } from "../../quality/kit-checkpoint-evidence.js";
import { collectLocalEvidence } from "../../quality/local-evidence.js";
import { harvestSkillProposals } from "./remember.js";
import { applyAdaptiveDecision, decideAdaptiveAction, effectiveGraph, failureFingerprint, renderAdaptationBlock } from "../../pipeline/adaptive-rules.js";
import type { AdaptiveDecision } from "../../pipeline/adaptive-rules.js";
import { advance, buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, escalate, renderModelRouting } from "../../routing/routing-engine.js";
import { defaultModelId, routingCohortForTask } from "../../routing/routing-context.js";
import { readRoutingState, updateRoutingState } from "../../routing/routing-state.js";
import { appendAttempt, readTelemetry } from "../../telemetry/telemetry-store.js";
import { parseTokenCount } from "../../telemetry/token-usage.js";
import { printWarnings, printWorkflowDirectiveIfAny, resolveProjectPath } from "./shared.js";
import { collectChangedFiles } from "../../governance/scope-guard.js";
import type { EvidenceVerdict } from "../../core/types.js";
import { DEFAULT_TIER, predictionForAttempt } from "./checkpoint/attempt-prediction.js";
import { runConfiguredKitCheckpoint } from "./checkpoint/kit-run.js";
import { writeCheckpointMarkdown } from "./checkpoint/markdown.js";

// Re-exported because they are pure formatters pinned directly by unit tests,
// which import them from this module rather than reaching into the internals.
export { decisionMemoryLine, taskCompletionMemory } from "./checkpoint/memory-ledger.js";
export { remainingTasksLine } from "./checkpoint/remaining-tasks.js";

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
    .addOption(
      new Option(
        "--input-tokens <n>",
        "Input tokens this task consumed, as reported by the host; recorded to telemetry and the kit budget ledger."
      )
    )
    .addOption(
      new Option(
        "--output-tokens <n>",
        "Output tokens this task produced, as reported by the host; recorded to telemetry and the kit budget ledger."
      )
    )
    .action(async function (
      this: Command,
      options: {
        task?: string;
        acceptWarnings?: boolean;
        tier?: string;
        model?: string;
        modelVersion?: string;
        inputTokens?: string;
        outputTokens?: string;
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
          acceptWarnings: options.acceptWarnings === true,
          inputTokens: parseTokenCount(options.inputTokens, "input-tokens"),
          outputTokens: parseTokenCount(options.outputTokens, "output-tokens")
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
