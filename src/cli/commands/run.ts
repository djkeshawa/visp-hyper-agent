import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { resolveProjectFile } from "../../core/project-path.js";
import { readState, updateActiveSession } from "../../core/session-manager.js";
import type { PipelineGraphIdentity, ToolProfile } from "../../core/types.js";
import {
  kitAuthoritativeTaskGraphSchema,
  type KitAuthoritativeContextPack,
  type KitAuthoritativeTaskGraph,
  type KitGateResult,
  type KitIntegrationContract,
  type KitStatus,
  type KitTask
} from "../../kit/kit-schemas.js";
import { provenanceFreshnessContractWarning } from "../../kit/kit-contract-compat.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import {
  buildActionBlock,
  currentTask,
  initialPipelineState,
  isPipelineComplete,
  readySet,
  validateTaskGraph
} from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { executeStart, prepareStrictKitAdoption } from "./start.js";
import {
  printWarnings,
  printWorkflowDirectiveIfAny,
  renderPipelineComplete,
  renderPipelineIdentityStop,
  resolveProjectPath
} from "./shared.js";

export function runCommand(): Command {
  return new Command("run")
    .description("Run a pipeline-aware coding session, gated by the external visp kit when present.")
    .argument("<goal>", "Implementation goal.")
    .addOption(
      new Option("--tool <tool>", "Tool profile.")
        .choices(["generic", "codex", "claude-code", "copilot", "opencode"])
    )
    .action(async function (this: Command, goal: string, options: { tool?: ToolProfile }) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);

      // Genuine Kit absence preserves the explicit local workflow. A configured
      // Kit that cannot be evaluated is an authority failure, not absence.
      if (kit.state === "absent") {
        const { handoff } = await executeStart(projectPath, goal, {
          ...options,
          authority: { mode: "local" }
        });
        console.log(handoff);
        return;
      }

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

      printWarnings(kit.warnings);

      const bridge = new KitCommandBridge({ projectPath });
      const contractDiagnostic = await bridge.integrationContractDiagnostic();
      printWarnings(bridge.warnings);
      if (!contractDiagnostic.ok) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: contractDiagnostic.reasonCode,
            reason: contractDiagnostic.reason
          })
        );
        return;
      }
      const contractWarning = provenanceFreshnessContractWarning(contractDiagnostic.value);
      if (contractWarning) {
        console.log(`warning: ${contractWarning}`);
      }

      const policy = await bridge.policyValidate();
      printWarnings(bridge.warnings);
      if (!policy) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "policy_unavailable",
            reason: "Kit policy validation was unavailable or malformed."
          })
        );
        return;
      }
      if (!policy.success || policy.validation.errors.length > 0) {
        console.log(
          renderPolicyBlocked({
            errors: policy.validation.errors,
            nextCommand: policy.nextCommand
          })
        );
        return;
      }

      const gateState = await bridge.gate("next");
      printWarnings(bridge.warnings);
      if (!gateState) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_next_unavailable",
            reason: "Kit gate-next evaluation was unavailable or malformed."
          })
        );
        return;
      }
      if (gateState.allowed === false) {
        console.log(
          renderAuthoritativeGateBlocked({
            stage: "gate_next",
            reasonCode: "gate_next_blocked",
            gate: gateState
          })
        );
        return;
      }

      const featureDirName = deriveFeatureDirName(kit.status);
      const configuredGraph = await loadConfiguredTaskGraph(
        projectPath,
        contractDiagnostic.value,
        featureDirName
      );

      if (!configuredGraph) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_graph_unavailable",
            reason: "The configured Kit task graph was unavailable or malformed."
          })
        );
        return;
      }

      const { graph, identity: graphIdentity } = configuredGraph;

      if (!featuresAgree(kit.status, contractDiagnostic.value, graph)) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_context_mismatch",
            reason: "Kit status, integration contract, and task graph did not identify the same active feature."
          })
        );
        return;
      }

      if (graph.tasks.length === 0) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_unavailable",
            reason: "The configured Kit task graph contains no executable task."
          })
        );
        return;
      }

      const pipeline = initialPipelineState(graph, graphIdentity);
      const task = currentTask(graph, pipeline);
      const contractTask = contractDiagnostic.value.activeTask;
      const statusTask = kit.status.activeTask;
      if (isPipelineComplete(pipeline)) {
        if (contractTask || statusTask) {
          console.log(
            renderKitAuthorityStop({
              status: "INCONCLUSIVE",
              reasonCode: "task_context_mismatch",
              reason: "The task graph was complete while Kit still identified an active task."
            })
          );
          return;
        }
        console.log(
          renderPipelineComplete({
            feature: graphIdentity.featureId && graphIdentity.featureSlug
              ? `${graphIdentity.featureId}-${graphIdentity.featureSlug}`
              : graphIdentity.featureId ?? graphIdentity.featureSlug,
            completedTasks: pipeline.completed
          })
        );
        return;
      }
      if (
        !task ||
        !contractTask ||
        !statusTask ||
        task.id !== contractTask.id ||
        task.id !== statusTask.id ||
        task.title !== contractTask.title ||
        (statusTask.title !== undefined && task.title !== statusTask.title)
      ) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_unavailable",
            reason: "Kit status, integration contract, and task graph did not identify the same executable current task."
          })
        );
        return;
      }

      const contextArtifact = await bridge.readAuthoritativeContextPackArtifact(
        task.id,
        contractDiagnostic.value
      );
      printWarnings(bridge.warnings);
      if (!contextArtifact) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "context_pack_unavailable",
            reason: `Kit context pack for ${task.id} was unavailable or malformed.`
          })
        );
        return;
      }

      if (!taskContextAgrees(task, contextArtifact.pack as KitAuthoritativeContextPack)) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_context_mismatch",
            reason: `Kit task graph and context pack disagreed on the scope for ${task.id}.`
          })
        );
        return;
      }

      const strictKitAdoption = await prepareStrictKitAdoption(projectPath, {
        taskId: task.id,
        artifact: contextArtifact,
        contract: contractDiagnostic.value
      });
      if (!strictKitAdoption) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "context_pack_unavailable",
            reason: `Kit context pack for ${task.id} yielded no usable, policy-allowed files.`
          })
        );
        return;
      }

      const implementGate = await bridge.gateImplement(task.id);
      printWarnings(bridge.warnings);

      if (!implementGate) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_implement_unavailable",
            reason: "Kit gate-implement evaluation was unavailable or malformed."
          })
        );
        return;
      }
      if (implementGate.allowed === false) {
        console.log(
          renderAuthoritativeGateBlocked({
            stage: "gate_implement",
            reasonCode: "gate_implement_blocked",
            task: task.id,
            gate: implementGate
          })
        );
        return;
      }

      // Create durable Hyper session state only after every required strict
      // precondition has produced a valid authoritative result.
      const { session, handoff } = await executeStart(projectPath, goal, {
        ...options,
        authority: { mode: "kit", adoption: strictKitAdoption }
      });
      const updated = await updateActiveSession(
        projectPath,
        (current) => ({ ...current, pipeline }),
        session.id
      );
      if (!updated) {
        console.log(
          renderPipelineIdentityStop({
            sessionId: session.id,
            reasonCode: "run_session_changed",
            reason: "The active session changed before the strict pipeline could be persisted."
          })
        );
        return;
      }

      const contextPackPath = strictKitAdoption.contextArtifact.path;
      const concurrentWith = readySet(graph, task.id, pipeline.completed);

      console.log(handoff);
      console.log("");
      console.log(buildActionBlock(task, { contextPackPath, sessionId: session.id, concurrentWith }));
      await printAndRecordRouting(projectPath, task);
      printWorkflowDirectiveIfAny(graph, pipeline, session.tool, session.id);
    });
}

/**
 * Compute the advisory model-routing suggestion for `task`, print it after the
 * action block, and persist the decision. Best-effort: a routing failure must
 * never break the run command, so errors are swallowed.
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
    // Advisory only; never fail the run because routing could not be computed.
  }
}

function deriveFeatureDirName(status: KitStatus): string | undefined {
  const feature = status.activeFeature;
  if (!feature) {
    return undefined;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}

function renderPolicyBlocked(input: { errors: string[]; nextCommand: string }): string {
  const lines = ["BEGIN_VISP_POLICY_BLOCKED"];
  if (input.errors.length > 0) {
    lines.push("errors:");
    for (const error of input.errors) {
      lines.push(`  - ${error}`);
    }
  } else {
    lines.push("errors:");
    lines.push("  - Policy validation failed.");
  }
  lines.push(`next_allowed_command: ${input.nextCommand}`);
  lines.push("END_VISP_POLICY_BLOCKED");
  return lines.join("\n");
}

/**
 * A configured strict run reads only the Kit contract's task-graph artifact.
 * It must never fall through to PLAN.md/TODO.md discovery, which belongs to
 * genuine Kit-less local mode.
 */
async function loadConfiguredTaskGraph(
  projectPath: string,
  contract: KitIntegrationContract,
  featureDirName?: string
): Promise<{ graph: KitAuthoritativeTaskGraph; identity: PipelineGraphIdentity } | null> {
  const contractPath = contract.artifacts.taskGraph;
  if (!contractPath || contractPath.includes("<")) {
    return null;
  }
  const expectedSuffix = featureDirName ? `.visp/features/${featureDirName}/task-graph.json` : undefined;
  try {
    const resolved = await resolveProjectFile(projectPath, contractPath, {
      mode: "read",
      blockedPaths: []
    });
    if (expectedSuffix && resolved.logicalPath !== expectedSuffix) {
      return null;
    }
    const parsed = JSON.parse(await readFile(resolved.absolutePath, "utf8")) as unknown;
    const result = kitAuthoritativeTaskGraphSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    const validation = validateTaskGraph(result.data);
    if (!validation.ok && result.data.tasks.length > 0) {
      return null;
    }
    return {
      graph: result.data,
      identity: {
        kind: "visp-kit",
        source: resolved.logicalPath,
        featureId: result.data.featureId,
        featureSlug: result.data.featureSlug
      }
    };
  } catch {
    return null;
  }
}

function featuresAgree(
  status: KitStatus,
  contract: KitIntegrationContract,
  graph: KitAuthoritativeTaskGraph
): boolean {
  const statusFeature = status.activeFeature;
  const contractFeature = contract.activeFeature;
  if (!statusFeature || !contractFeature) {
    return false;
  }
  return (
    statusFeature.id === contractFeature.id &&
    statusFeature.slug === contractFeature.slug &&
    graph.featureId === contractFeature.id &&
    graph.featureSlug === contractFeature.slug
  );
}

function taskContextAgrees(task: KitTask, pack: KitAuthoritativeContextPack): boolean {
  const selected = pack.selectedTask;
  return (
    selected.id === task.id &&
    selected.title === task.title &&
    selected.description === task.description &&
    sameStrings(selected.requirementIds, task.requirementIds) &&
    sameStrings(selected.acceptanceCriterionIds, task.acceptanceCriterionIds) &&
    sameStrings(selected.dependsOn, task.dependsOn) &&
    sameStrings(selected.allowedFiles, task.allowedFiles) &&
    sameStrings(selected.expectedFiles, task.expectedFiles) &&
    sameStrings(selected.forbiddenFiles, task.forbiddenFiles) &&
    sameStrings(selected.validationCommands, task.validationCommands) &&
    selected.status === task.status &&
    selected.parallelizable === task.parallelizable &&
    selected.riskLevel === task.riskLevel
  );
}

function sameStrings(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

/**
 * Preserve the established blocked-pipeline frame while making the pre-session
 * gate-next stop explicit. Unlike the later implementation-gate renderer, this
 * path never asks `visp next` and never fabricates a fallback command.
 */
function renderAuthoritativeGateBlocked(input: {
  stage: "gate_next" | "gate_implement";
  reasonCode: "gate_next_blocked" | "gate_implement_blocked";
  gate: KitGateResult;
  task?: string;
}): string {
  const lines = [
    "BEGIN_VISP_PIPELINE_BLOCKED",
    `stage: ${input.stage}`,
    ...(input.task ? [`task: ${input.task}`] : []),
    "status: BLOCKED",
    `reason_code: ${input.reasonCode}`,
    "failed_rules:"
  ];
  if (input.gate.failedRules.length > 0) {
    for (const rule of input.gate.failedRules) {
      lines.push(`  - ${rule.ruleId}: ${rule.message}`.trimEnd());
    }
  } else {
    lines.push("  - none");
  }
  if (input.gate.nextCommand) {
    lines.push(`next_allowed_command: ${input.gate.nextCommand}`);
  }
  lines.push("END_VISP_PIPELINE_BLOCKED");
  return lines.join("\n");
}
