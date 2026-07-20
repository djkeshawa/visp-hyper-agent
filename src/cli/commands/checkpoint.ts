import { Command, Option } from "commander";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { execFileResolved } from "../../core/executable-resolver.js";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { resolveProjectFile } from "../../core/project-path.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import {
  detectVisp,
  KitCommandBridge,
  type KitContextPackArtifact
} from "../../kit/kit-command-bridge.js";
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
  effectiveGraph,
  renderAdaptationBlock,
  type AdaptiveDecision
} from "../../pipeline/adaptive-rules.js";
import {
  advance,
  buildActionBlock,
  currentTask,
  isPipelineComplete,
  loadTaskGraphByIdentity,
  pinInjectedTaskIntegrity,
  validatePipelineState
} from "../../pipeline/pipeline-engine.js";
import {
  computeSuggestedTier,
  escalate,
  renderModelRouting
} from "../../routing/routing-engine.js";
import { readRoutingState, updateRoutingState } from "../../routing/routing-state.js";
import { appendAttempt, readTelemetry } from "../../telemetry/telemetry-store.js";
import {
  printWarnings,
  printWorkflowDirectiveIfAny,
  renderPipelineComplete,
  renderPipelineIdentityStop,
  resolveProjectPath
} from "./shared.js";
import { collectChangedFiles } from "../../governance/scope-guard.js";
import type { EvidenceVerdict } from "../../core/types.js";
import type {
  KitAuthoritativeContextPack,
  KitIntegrationContract,
  KitReconcileSummary,
  KitReviewSummary,
  KitStatus,
  KitVerifySummary,
  WorkflowActionV2
} from "../../kit/kit-schemas.js";

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

      if (!options.task) {
        await writeCheckpointMarkdown(projectPath, session.id, session.goal);
        console.log("Checkpoint written to .visp/hyper/current/checkpoints.md");
        return;
      }

      const taskId = options.task;
      const [kit, contextFreshness] = await Promise.all([
        detectVisp(projectPath),
        checkContextFreshness(projectPath)
      ]);
      if (kit.state === "configured-unhealthy") {
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
        return;
      }

      const pipeline = session.pipeline;
      if (!pipeline?.graphIdentity || !pipeline.taskKeys) {
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
        if (kit.state === "healthy" && contextFreshness.blocking) {
          console.log(
            renderKitCheckpointEvidence({
              taskId,
              evidence: aggregateKitCheckpointEvidence({
                verify: null,
                review: null,
                blockingFindings: [
                  stateValidation.reason,
                  contextFreshness.finding ?? "strict Kit context freshness check failed"
                ]
              }),
              contextFreshness: contextFreshness.status,
              warnings: contextFreshness.warnings
            })
          );
          return;
        }
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
        if (kit.state === "healthy") {
          console.log(
            renderKitCheckpointEvidence({
              taskId,
              evidence: unavailableKitCheckpointEvidence({
                reasonCode: "kit_pipeline_completion_unconfirmed",
                reason:
                  "Hyper's persisted pipeline mirror is complete, but live Kit authority has not confirmed a checkpoint completion action."
              }),
              contextFreshness: contextFreshness.status,
              warnings: contextFreshness.warnings
            })
          );
          return;
        }
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

      const currentTaskId = pipeline.currentTaskId;
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

      await writeCheckpointMarkdown(projectPath, session.id, session.goal, taskId);

      const taskClass = task?.riskLevel ?? "unknown";

      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const contractDiagnostic = await bridge.integrationContractDiagnostic();
        const liveContract = contractDiagnostic.ok ? contractDiagnostic.value : undefined;
        const liveContextArtifact = liveContract
          ? await bridge.readAuthoritativeContextPackArtifact(taskId, liveContract)
          : null;
        const strictContextFindings = !contractDiagnostic.ok
          ? [contractDiagnostic.reason]
          : await validateStrictContextManifest(
              projectPath,
              session.id,
              taskId,
              kit.status,
              contractDiagnostic.value,
              liveContextArtifact
            );
        if (contextFreshness.status !== "current") {
          strictContextFindings.push(
            contextFreshness.finding ??
              `strict Kit context freshness is ${contextFreshness.status}; regenerate the handoff before checkpointing`
          );
        }
        if (strictContextFindings.length > 0) {
          printWarnings(bridge.warnings);
          console.log(
            renderKitCheckpointEvidence({
              taskId,
              evidence: aggregateKitCheckpointEvidence({
                verify: null,
                review: null,
                blockingFindings: strictContextFindings
              }),
              contextFreshness: contextFreshness.status,
              warnings: contextFreshness.warnings
            })
          );
          return;
        }

        const verify = normalizeStructuredErrorFindings(
          "verify",
          taskId,
          await bridge.verify(taskId)
        );
        const verifyEvidence = aggregateKitCheckpointEvidence({
          verify,
          review: null
        });
        if (verifyEvidence.verifyVerdict !== "passed") {
          printKitCheckpointResult(bridge, taskId, verifyEvidence, contextFreshness);
          return;
        }

        const review = normalizeStructuredErrorFindings(
          "review",
          taskId,
          await bridge.review(taskId)
        );
        const reviewEvidence = aggregateKitCheckpointEvidence({ verify, review });
        if (reviewEvidence.reviewVerdict !== "passed") {
          printKitCheckpointResult(bridge, taskId, reviewEvidence, contextFreshness);
          return;
        }

        const reconcile = normalizeReconcileAuthority(
          normalizeStructuredErrorFindings("reconcile", taskId, await bridge.reconcile(taskId)),
          `${normalizeManifestPath(liveContract?.activeFeature?.path) ?? ""}/traceability.json`
        );
        const reconciledEvidence = aggregateKitCheckpointEvidence({ verify, review, reconcile });
        if (reconciledEvidence.reconcileVerdict !== "passed") {
          printKitCheckpointResult(bridge, taskId, reconciledEvidence, contextFreshness);
          return;
        }

        // WorkflowAction 2.0 is the only current post-checkpoint authority. It
        // may identify the exact next action, but it does not expose enough
        // state for Hyper to mutate or complete its mirrored strict pipeline.
        const nextAction = await bridge.nextActionDiagnostic();
        printKitCheckpointResult(bridge, taskId, reconciledEvidence, contextFreshness);
        if (nextAction.ok) {
          console.log("");
          console.log(renderWorkflowAction(nextAction.value));
        }
        return;
      }

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
        pipeline,
        graph,
        { verifyPassed, reviewPassed, detail: `${evidenceSource}-evidence` },
        new Date().toISOString()
      );
      const updated = await updateActiveSession(
        projectPath,
        (current) => ({ ...current, pipeline: nextState }),
        session.id
      );
      if (!updated) {
        console.log(
          renderPipelineIdentityStop({
            sessionId: session.id,
            reasonCode: "checkpoint_session_changed",
            reason: "The active session changed before checkpoint results could be persisted."
          })
        );
        return;
      }

      let adaptiveDecision: AdaptiveDecision = { action: "none" };
      if (verdict === "failed" && task) {
        try {
          adaptiveDecision = decideAdaptiveAction({ state: nextState, task, findings: failureFindings });
          if (adaptiveDecision.action !== "none") {
            const adapted = pinInjectedTaskIntegrity(
              applyAdaptiveDecision(nextState, adaptiveDecision, taskId, new Date().toISOString())
            );
            const adaptedSession = await updateActiveSession(
              projectPath,
              (current) => ({ ...current, pipeline: adapted }),
              session.id
            );
            if (!adaptedSession) {
              console.log(
                renderPipelineIdentityStop({
                  sessionId: session.id,
                  reasonCode: "checkpoint_session_changed",
                  reason: "The active session changed before pipeline adaptation could be persisted."
                })
              );
              return;
            }
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
            state, taskId, taskClass,
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

function printKitCheckpointResult(
  bridge: KitCommandBridge,
  taskId: string,
  evidence: ReturnType<typeof aggregateKitCheckpointEvidence>,
  contextFreshness: Awaited<ReturnType<typeof checkContextFreshness>>
): void {
  printWarnings(bridge.warnings);
  console.log(
    renderKitCheckpointEvidence({
      taskId,
      evidence,
      contextFreshness: contextFreshness.status,
      warnings: contextFreshness.warnings
    })
  );
}

type KitEvidenceSummary = KitVerifySummary | KitReviewSummary | KitReconcileSummary;

function normalizeStructuredErrorFindings<T extends KitEvidenceSummary>(
  stage: "verify" | "review" | "reconcile",
  taskId: string,
  summary: T | null
): T | null {
  if (!summary?.success) {
    return summary;
  }
  const blocking = (summary.findings ?? []).filter(isErrorFinding);
  const authorityErrors =
    summary.taskId === taskId
      ? []
      : [`${stage} evidence identifies task ${summary.taskId ?? "none"}; expected ${taskId}`];
  if (blocking.length === 0 && authorityErrors.length === 0) {
    return summary;
  }
  return {
    ...summary,
    success: false,
    errors: [
      ...(summary.errors ?? []),
      ...blocking.map((finding) => `${stage} error finding: ${renderFinding(finding)}`),
      ...authorityErrors
    ]
  };
}

function normalizeReconcileAuthority(
  reconcile: KitReconcileSummary | null,
  expectedTraceabilityPath: string
): KitReconcileSummary | null {
  if (!reconcile) {
    return null;
  }
  const errors: string[] = [];
  if (!reconcile.traceabilityUpdate?.requested) {
    errors.push("reconcile evidence does not confirm that a traceability update was requested");
  }
  if (!reconcile.traceabilityUpdate?.performed) {
    errors.push("reconcile evidence does not confirm that traceability was updated");
  }
  const updatedFiles = reconcile.traceabilityUpdate?.updatedFiles.map(normalizeManifestPath) ?? [];
  if (!updatedFiles.includes(expectedTraceabilityPath)) {
    errors.push(
      `reconcile evidence does not identify the updated traceability artifact ${expectedTraceabilityPath}`
    );
  }
  if (errors.length === 0) {
    return reconcile;
  }
  return {
    ...reconcile,
    success: false,
    errors: [...(reconcile.errors ?? []), ...errors]
  };
}

function isErrorFinding(finding: unknown): boolean {
  if (!finding || typeof finding !== "object") {
    return false;
  }
  const record = finding as Record<string, unknown>;
  return typeof record.severity === "string" && record.severity.trim().toLowerCase() === "error";
}

function renderFinding(finding: unknown): string {
  if (typeof finding === "string") {
    return finding;
  }
  if (finding && typeof finding === "object") {
    const record = finding as Record<string, unknown>;
    for (const key of ["title", "message", "description", "summary"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
  }
  return JSON.stringify(finding) ?? String(finding);
}

async function validateStrictContextManifest(
  projectPath: string,
  sessionId: string,
  taskId: string,
  status: KitStatus,
  contract: KitIntegrationContract,
  liveContextArtifact: KitContextPackArtifact | null
): Promise<string[]> {
  const path = vispPath(projectPath, "hyper", "current", "context-manifest.json");
  const raw = await readTextIfExists(path);
  if (!raw) {
    return ["strict Kit context manifest is missing"];
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return ["strict Kit context manifest is malformed"];
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return ["strict Kit context manifest is malformed"];
  }

  const findings: string[] = [];
  if (manifest.sessionId !== sessionId) {
    findings.push("strict Kit context manifest does not belong to the active session");
  }
  if (manifest.taskId !== taskId) {
    findings.push(`strict Kit context manifest does not identify task ${taskId}`);
  }
  const selectedFiles = manifest.selectedFiles;
  if (
    !Array.isArray(selectedFiles) ||
    selectedFiles.length === 0 ||
    selectedFiles.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as Record<string, unknown>).path !== "string" ||
        (entry as Record<string, unknown>).hasContent !== true
    )
  ) {
    findings.push("strict Kit context manifest has no non-empty selected files");
  }
  const contextArtifact = manifest.contextArtifact as Record<string, unknown> | undefined;
  if (!liveContextArtifact) {
    findings.push(`live authoritative context for ${taskId} was unavailable or malformed`);
  } else {
    if (
      normalizeManifestPath(contextArtifact?.path) !== normalizeManifestPath(contract.artifacts.contextPack) ||
      contextArtifact?.hash !== liveContextArtifact.sha256 ||
      contextArtifact?.hashAlgorithm !== "sha256"
    ) {
      findings.push(`strict Kit context manifest does not pin the live context artifact for ${taskId}`);
    }
    findings.push(
      ...selectedFileManifestFindings(
        selectedFiles,
        liveContextArtifact.pack as KitAuthoritativeContextPack,
        taskId
      )
    );
  }
  const readContract = manifest.kitReadContract as Record<string, unknown> | undefined;
  if (readContract?.contractVersion !== "2.0") {
    findings.push("strict Kit context manifest does not identify integration contract 2.0");
  }
  if (readContract?.readContractVersion !== "0.1") {
    findings.push("strict Kit context manifest does not pin read contract 0.1");
  }
  const artifacts = parseRequiredArtifacts(readContract?.requiredArtifacts);
  const contextPack = artifacts.get("context-pack");
  const featurePrompt = artifacts.get("context-prompt");
  const currentPrompt = artifacts.get("current-task-prompt");
  const contextArtifactPath = normalizeManifestPath(contextArtifact?.path);
  findings.push(
    ...liveAuthorityFindings(status, contract, taskId, contextArtifactPath, artifacts)
  );

  if (
    !isImplementationArtifact(contextPack, "application/json", "hash-pinned") ||
    contextPack.path !== contextArtifactPath ||
    !contextPack.path.endsWith(`/context/${taskId}.context.json`)
  ) {
    findings.push(`strict Kit context manifest does not declare the exact context pack for ${taskId}`);
  }

  const expectedFeaturePromptPath = contextPack?.path.replace(/\.context\.json$/u, ".prompt.md");
  if (
    !isImplementationArtifact(featurePrompt, "text/markdown", "read-latest") ||
    featurePrompt.path !== expectedFeaturePromptPath
  ) {
    findings.push(`strict Kit context manifest does not declare the feature prompt for ${taskId}`);
  }
  if (
    !isImplementationArtifact(currentPrompt, "text/markdown", "read-latest") ||
    currentPrompt.path !== ".visp/prompts/current-task.prompt.md"
  ) {
    findings.push(`strict Kit context manifest does not declare the current task prompt for ${taskId}`);
  }

  const featurePromptText = featurePrompt
    ? await readLivePrompt(projectPath, featurePrompt.path, taskId, "feature prompt", findings)
    : undefined;
  const currentPromptText = currentPrompt
    ? await readLivePrompt(projectPath, currentPrompt.path, taskId, "current task prompt", findings)
    : undefined;
  if (
    featurePromptText !== undefined &&
    currentPromptText !== undefined &&
    !promptReferencesPath(currentPromptText, featurePrompt!.path)
  ) {
    findings.push(`strict Kit current task prompt does not point to the feature prompt for ${taskId}`);
  }
  return findings;
}

function selectedFileManifestFindings(
  value: unknown,
  pack: KitAuthoritativeContextPack,
  taskId: string
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const selected = new Map<string, Record<string, unknown>>();
  let invalid = false;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      invalid = true;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = normalizeManifestPath(record.path);
    if (!path || selected.has(path)) {
      invalid = true;
      continue;
    }
    selected.set(path, record);
  }

  const expectedPaths = new Set<string>();
  for (const expected of pack.includedFiles) {
    const path = normalizeManifestPath(expected.path);
    if (!path || expectedPaths.has(path)) {
      invalid = true;
      continue;
    }
    expectedPaths.add(path);
    const stored = selected.get(path);
    const plannedNewFile = expected.includeMode === "new-file" && expected.hash === "new-file";
    if (
      !stored ||
      stored.reason !== expected.reason ||
      stored.hasContent !== true ||
      (plannedNewFile
        ? stored.sourceHash !== undefined ||
          stored.sourceHashAlgorithm !== undefined ||
          stored.sourceHashSource !== undefined
        : stored.sourceHash !== expected.hash ||
          stored.sourceHashAlgorithm !== "sha256" ||
          stored.sourceHashSource !== "visp-kit")
    ) {
      invalid = true;
    }
  }
  if (selected.size !== expectedPaths.size) {
    invalid = true;
  }
  return invalid
    ? [`strict Kit context manifest selected files do not exactly match the context pack for ${taskId}`]
    : [];
}

type ManifestArtifact = {
  path: string;
  role: string;
  mimeType: string;
  requiredFor: string[];
  freshness?: string;
};

function liveAuthorityFindings(
  status: KitStatus,
  contract: KitIntegrationContract,
  taskId: string,
  contextArtifactPath: string | undefined,
  manifestArtifacts: Map<string, ManifestArtifact>
): string[] {
  const findings: string[] = [];
  const statusTask = status.activeTask;
  const contractTask = contract.activeTask;
  if (
    !contract.initialized ||
    !statusTask ||
    !contractTask ||
    statusTask.id !== taskId ||
    contractTask.id !== taskId ||
    (statusTask.title !== undefined && statusTask.title !== contractTask.title)
  ) {
    findings.push(`live Kit status and contract do not identify task ${taskId}`);
  }

  const statusFeature = status.activeFeature;
  const contractFeature = contract.activeFeature;
  if (!statusFeature || !contractFeature) {
    findings.push(`live Kit status and contract do not identify the feature for ${taskId}`);
    return findings;
  }

  const expectedFeatureKey = `${contractFeature.id}-${contractFeature.slug}`;
  const expectedFeaturePath = `.visp/features/${expectedFeatureKey}`;
  const expectedContextPath = `${expectedFeaturePath}/context/${taskId}.context.json`;
  const expectedPromptPath = `${expectedFeaturePath}/context/${taskId}.prompt.md`;
  if (
    statusFeature.id !== contractFeature.id ||
    statusFeature.slug !== contractFeature.slug ||
    contractFeature.key !== expectedFeatureKey ||
    normalizeManifestPath(contractFeature.path) !== expectedFeaturePath ||
    normalizeManifestPath(contract.artifacts.featureDir) !== expectedFeaturePath ||
    normalizeManifestPath(contract.artifacts.contextPack) !== expectedContextPath ||
    normalizeManifestPath(contract.artifacts.contextPrompt) !== expectedPromptPath ||
    contextArtifactPath !== expectedContextPath
  ) {
    findings.push(`live Kit feature or context identity changed for ${taskId}`);
  }

  if (contract.orchestrator?.readContractVersion !== "0.1") {
    findings.push("live Kit contract does not expose read contract 0.1");
  }
  const liveArtifacts = parseRequiredArtifacts(contract.orchestrator?.requiredArtifacts);
  for (const id of ["context-pack", "context-prompt", "current-task-prompt"]) {
    if (!sameManifestArtifact(manifestArtifacts.get(id), liveArtifacts.get(id))) {
      findings.push(`live Kit ${id} declaration changed since the strict handoff`);
    }
  }
  const implementationReadSet = new Set(
    (contract.workflow?.implementationReadSet ?? []).map((path) =>
      normalizeManifestPath(path)
    )
  );
  if (
    (!implementationReadSet.has(expectedContextPath) &&
      !implementationReadSet.has(".visp/features/<feature>/context/<task-id>.context.json")) ||
    !implementationReadSet.has(".visp/prompts/current-task.prompt.md")
  ) {
    findings.push("live Kit implementation read set no longer declares the strict task context");
  }
  return findings;
}

function sameManifestArtifact(
  stored: ManifestArtifact | undefined,
  live: ManifestArtifact | undefined
): boolean {
  return Boolean(
    stored &&
      live &&
      stored.path === live.path &&
      stored.role === live.role &&
      stored.mimeType === live.mimeType &&
      stored.freshness === live.freshness &&
      sameStringSet(stored.requiredFor, live.requiredFor)
  );
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((entry) => right.includes(entry))
  );
}

function parseRequiredArtifacts(value: unknown): Map<string, ManifestArtifact> {
  const artifacts = new Map<string, ManifestArtifact>();
  const duplicateIds = new Set<string>();
  if (!Array.isArray(value)) {
    return artifacts;
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const path = normalizeManifestPath(record.path);
    if (
      typeof record.id !== "string" ||
      !path ||
      typeof record.role !== "string" ||
      typeof record.mimeType !== "string" ||
      !Array.isArray(record.requiredFor) ||
      !record.requiredFor.every((stage): stage is string => typeof stage === "string")
    ) {
      continue;
    }
    if (artifacts.has(record.id) || duplicateIds.has(record.id)) {
      artifacts.delete(record.id);
      duplicateIds.add(record.id);
      continue;
    }
    artifacts.set(record.id, {
      path,
      role: record.role,
      mimeType: record.mimeType,
      requiredFor: record.requiredFor,
      ...(typeof record.freshness === "string" ? { freshness: record.freshness } : {})
    });
  }
  return artifacts;
}

function isImplementationArtifact(
  artifact: ManifestArtifact | undefined,
  expectedMimeType: string,
  expectedFreshness?: string
): artifact is ManifestArtifact {
  return Boolean(
    artifact?.requiredFor.includes("implementation") &&
      artifact.mimeType === expectedMimeType &&
      (!expectedFreshness || artifact.freshness === expectedFreshness)
  );
}

function normalizeManifestPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

async function readLivePrompt(
  projectPath: string,
  path: string,
  taskId: string,
  label: string,
  findings: string[]
): Promise<string | undefined> {
  try {
    const resolved = await resolveProjectFile(projectPath, path, {
      mode: "read",
      blockedPaths: []
    });
    if (resolved.logicalPath !== path) {
      findings.push(`strict Kit ${label} path is not canonical for ${taskId}`);
      return undefined;
    }
    const text = await readTextIfExists(resolved.absolutePath);
    if (!text?.trim() || !promptSelectsTask(text, taskId)) {
      findings.push(`strict Kit ${label} is missing, blank, or does not identify ${taskId}`);
      return undefined;
    }
    return text;
  } catch {
    findings.push(`strict Kit ${label} could not be read safely for ${taskId}`);
    return undefined;
  }
}

function promptSelectsTask(value: string, taskId: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  const selections = Array.from(
    value.matchAll(/^(?:-\s*)?Selected task ID:\s*([^\r\n]*?)\s*$/gmu),
    (match) => match[1]
  );
  return selections.length === 1 && selections[0] === taskId;
}

function promptReferencesPath(value: string, path: string): boolean {
  const lines = value.split(/\r?\n/u);
  const labels = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line === "Feature-specific prompt:");
  if (labels.length !== 1) {
    return false;
  }
  const label = labels[0];
  return label !== undefined && lines[label.index + 1]?.trim() === path;
}

function renderWorkflowAction(action: WorkflowActionV2): string {
  return [
    "BEGIN_VISP_WORKFLOW_ACTION_V2",
    JSON.stringify(action),
    "END_VISP_WORKFLOW_ACTION_V2"
  ].join("\n");
}

async function writeCheckpointMarkdown(
  projectPath: string,
  sessionId: string,
  goal: string,
  taskId?: string
): Promise<void> {
  const [{ stdout: stat }, snapshot] = await Promise.all([
    execFileResolved("git", ["diff", "--stat", "HEAD"], { cwd: projectPath }),
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
