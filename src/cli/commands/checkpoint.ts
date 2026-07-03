import { Command, Option } from "commander";
import { execFileCrossPlatform } from "../../core/exec.js";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import type { KitReviewSummary, KitVerifySummary } from "../../kit/kit-schemas.js";
import { readRelevantFailurePatterns, recordFailurePattern } from "../../memory/failure-patterns.js";
import { createCheckpointSnapshot, writeCheckpointSnapshot } from "../../quality/checkpoint-snapshot.js";
import { collectLocalEvidence } from "../../quality/local-evidence.js";
import { harvestSkillProposals } from "./remember.js";
import {
  applyAdaptiveDecision,
  decideAdaptiveAction,
  effectiveGraph,
  evidenceRequirements,
  renderAdaptationBlock,
  type AdaptiveDecision
} from "../../pipeline/adaptive-rules.js";
import { advance, buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import {
  computeSuggestedTier,
  escalate,
  renderModelRouting
} from "../../routing/routing-engine.js";
import { readRoutingState, updateRoutingState } from "../../routing/routing-state.js";
import { appendAttempt, readTelemetry } from "../../telemetry/telemetry-store.js";
import { printWarnings, printWorkflowDirectiveIfAny, resolveProjectPath } from "./shared.js";
import { collectChangedFiles } from "../../governance/scope-guard.js";

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
        // Degrade, never crash: a thrown stack trace mid-orchestration derails
        // the coding agent's loop; a clean message + exit code does not.
        console.log("No active Visp Hyper session. Run `visp-hyper start` first.");
        process.exitCode = 1;
        return;
      }

      await writeCheckpointMarkdown(projectPath, session.id, session.goal, options.task);

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
      // session) which exists nowhere on disk. Injected remediation tasks are
      // merged in-memory so they are checkpointable like any other task.
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
      const taskClass = task?.riskLevel ?? "unknown";
      const contextFreshness = await checkContextFreshness(projectPath);

      const kit = await detectVisp(projectPath);
      let verifyPassed: boolean;
      let reviewPassed: boolean;
      let evidenceSource: "kit" | "local";
      let localFindings: string[] = [];
      let failureFindings: string[] = [];

      if (kit.available) {
        const bridge = new KitCommandBridge({ projectPath });
        const verify = await bridge.verify(taskId);
        const review = await bridge.review(taskId);
        printWarnings(bridge.warnings);
        verifyPassed = verify?.success === true;
        reviewPassed = review?.success === true;
        evidenceSource = "kit";
        failureFindings = [
          ...summaryFindings("verify", verify),
          ...summaryFindings("review", review)
        ];
      } else {
        const config = await readConfig(projectPath);
        const evidence = await collectLocalEvidence({
          projectPath,
          task: {
            id: taskId,
            allowedFiles: task?.allowedFiles,
            validationCommands: task?.validationCommands
          },
          blockedPaths: config.blockedPaths,
          configValidationCommands: config.validationCommands
        });
        verifyPassed = evidence.verifyPassed;
        reviewPassed = evidence.reviewPassed;
        localFindings = evidence.findings;
        evidenceSource = "local";
        failureFindings = localFindings;
        printWarnings([...kit.warnings, ...evidence.warnings]);
      }
      if (contextFreshness.blocking) {
        reviewPassed = false;
        failureFindings = [
          ...failureFindings,
          contextFreshness.finding ?? "context freshness check failed"
        ];
        if (evidenceSource === "local") {
          localFindings = [...localFindings, contextFreshness.finding ?? "context freshness check failed"];
        }
      }

      // Tightened evidence for high-risk or repeatedly-failing task classes:
      // verify may not pass vacuously (with no validation commands at all).
      // Only ever tightens the gate; failures to compute it are swallowed.
      try {
        const patterns = await readRelevantFailurePatterns(projectPath, {
          taskId,
          taskClass,
          files: task?.allowedFiles
        });
        const requirements = evidenceRequirements(task, patterns);
        const vacuousVerify =
          evidenceSource === "local" &&
          localFindings.includes("no validation commands detected; verify passed vacuously");
        if (requirements.strictEvidence && verifyPassed && vacuousVerify) {
          verifyPassed = false;
          const finding =
            "strict evidence: this task class requires real validation evidence; declare validationCommands on the task or in config.json";
          failureFindings = [...failureFindings, finding];
          localFindings = [...localFindings, finding];
        }
      } catch {
        // Advisory tightening only; never fail the checkpoint machinery itself.
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

      // Deterministic adaptation: repeated failures inject a scoped remediation
      // task or issue an escalation directive. Best-effort like routing — a
      // failure here must never break the checkpoint itself.
      let adaptiveDecision: AdaptiveDecision = { action: "none" };
      if (!passed && task) {
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
      if (!passed) {
        try {
          const hyperState = await readState(projectPath);
          await updateRoutingState(projectPath, (state) =>
            escalate({
              state,
              taskId,
              taskClass,
              sessionCount: Object.keys(hyperState.sessions).length,
              now: new Date().toISOString()
            })
          );
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
            taskClass,
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
        `verify: ${verifyPassed ? "PASSED" : "FAILED"}`,
        `review: ${reviewPassed ? "PASSED" : "FAILED"}`,
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

      const adaptationBlock = renderAdaptationBlock(taskId, adaptiveDecision);
      if (adaptationBlock) {
        console.log("");
        console.log(adaptationBlock);
        if (adaptiveDecision.action === "inject-remediation") {
          console.log("");
          console.log(buildActionBlock(adaptiveDecision.remediationTask, { sessionId: session.id }));
        }
      }

      // On a pass with a next task, advise the routing tier for that task and
      // print the fan-out directive for the remaining DAG when it applies.
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

function summaryFindings(label: "verify" | "review", summary: KitVerifySummary | KitReviewSummary | null): string[] {
  if (!summary) {
    return [`${label} evidence was unavailable or unparseable`];
  }
  if (summary.success) {
    return [];
  }
  const findings = [
    `${label} failed`,
    ...(summary.errors ?? []).map((entry) => `${label} error: ${entry}`),
    ...(summary.warnings ?? []).map((entry) => `${label} warning: ${entry}`),
    ...(summary.findings ?? []).map((entry) => `${label} finding: ${stringifyFinding(entry)}`)
  ];
  return [...new Set(findings.filter((entry) => entry.trim().length > 0))];
}

function stringifyFinding(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["title", "message", "description", "summary"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
  }
  return JSON.stringify(value) ?? String(value);
}

async function writeCheckpointMarkdown(
  projectPath: string,
  sessionId: string,
  goal: string,
  taskId?: string
): Promise<void> {
  const [{ stdout: stat }, snapshot] = await Promise.all([
    execFileCrossPlatform("git", ["diff", "--stat", "HEAD"], { cwd: projectPath }),
    createCheckpointSnapshot(projectPath, { sessionId, goal, taskId })
  ]);
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
    stat.trim() || "_No diff._",
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
