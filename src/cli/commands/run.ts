import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readState } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import {
  kitAuthoritativeTaskGraphSchema,
  type KitAuthoritativeTaskGraph,
  type KitGateResult,
  type KitIntegrationContract,
  type KitStatus
} from "../../kit/kit-schemas.js";
import { provenanceFreshnessContractWarning } from "../../kit/kit-contract-compat.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import type { NormalizedWorkflowAction } from "../../kit/workflow-action-adapter.js";
import { supportsStrictSessionAdoption } from "../../kit/workflow-action-protocol.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../kit/workflow-action-renderer.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { routingCohortForTask } from "../../routing/routing-context.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { executeStart, prepareStrictKitAdoption } from "./start.js";
import { printWarnings, resolveProjectPath } from "./shared.js";

export function runCommand(): Command {
  return new Command("run")
    .description("Run a pipeline-aware coding session, gated by the external visp kit when present.")
    .argument("<goal>", "Implementation goal.")
    .addOption(
      new Option("--tool <tool>", "Tool profile.")
        .choices(["generic", "codex", "claude-code", "copilot", "opencode"])
    )
    .addOption(new Option("--target-model <model-id>", "Exact cheap-tier model ID to evaluate for advisory routing."))
    .addOption(new Option("--target-model-version <version>", "Exact cheap-tier model version to evaluate for advisory routing."))
    .action(async function (
      this: Command,
      goal: string,
      options: { tool?: ToolProfile; targetModel?: string; targetModelVersion?: string }
    ) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);

      // Genuine Kit absence preserves the explicit local workflow. A configured
      // Kit that cannot be evaluated is an authority failure, not absence.
      if (kit.state === "absent") {
        const { handoff } = await executeStart(projectPath, goal, {
          tool: options.tool,
          authority: { mode: "local" }
        });
        console.log(handoff);
        return;
      }

      if (kit.state === "configured-unhealthy") {
        failStrictRun(
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
        failStrictRun(
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

      const actionDiagnostic = await bridge.nextCanonicalActionDiagnostic(
        "auto",
        contractDiagnostic.value
      );
      printWarnings(bridge.warnings);
      if (!actionDiagnostic.ok) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: actionDiagnostic.reasonCode,
            reason: actionDiagnostic.reason
          })
        );
        return;
      }
      const action = actionDiagnostic.value;
      if (action.verdict !== "ready") {
        console.log(renderHyperActionFrame(toHyperActionEnvelope(action)));
        process.exitCode = 1;
        return;
      }
      if (
        !supportsStrictSessionAdoption(action.source.protocolVersion) ||
        action.phase.state !== "available" ||
        action.phase.value !== "implement" ||
        action.task === null
      ) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "strict_session_adoption_unavailable",
            reason: strictAdoptionRefusalReason(action)
          }),
          action
        );
        return;
      }
      const taskId = action.task.id;

      const policy = await bridge.policyValidate();
      printWarnings(bridge.warnings);
      if (!policy) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "policy_unavailable",
            reason: "Kit policy validation was unavailable or malformed."
          }),
          action
        );
        return;
      }
      if (!policy.success || policy.validation.errors.length > 0) {
        failStrictRun(
          renderPolicyBlocked({
            errors: policy.validation.errors,
            nextCommand: policy.nextCommand
          }),
          action
        );
        return;
      }

      const gateState = await bridge.gate("next");
      printWarnings(bridge.warnings);
      if (!gateState) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_next_unavailable",
            reason: "Kit gate-next evaluation was unavailable or malformed."
          }),
          action
        );
        return;
      }
      if (gateState.allowed === false) {
        failStrictRun(
          renderAuthoritativeGateBlocked({
            stage: "gate_next",
            reasonCode: "gate_next_blocked",
            gate: gateState
          }),
          action
        );
        return;
      }
      if (gateState.taskId !== taskId) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_next_task_mismatch",
            reason: `Kit gate-next evaluated task ${gateState.taskId ?? "none"}; expected canonical task ${taskId}.`
          }),
          action
        );
        return;
      }

      const featureDirName = deriveFeatureDirName(kit.status);
      const graph = await loadConfiguredTaskGraph(
        projectPath,
        contractDiagnostic.value,
        featureDirName
      );

      if (!graph) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_graph_unavailable",
            reason: "The configured Kit task graph was unavailable or malformed."
          }),
          action
        );
        return;
      }

      const graphTask = graph.tasks.find((candidate) => candidate.id === taskId);
      const contractTaskId = contractDiagnostic.value.activeTask?.id;
      const statusTaskId = kit.status.activeTask?.id;
      const actionTaskStatus =
        action.task.status.state === "available" ? action.task.status.value : undefined;
      if (
        !graphTask ||
        !contractTaskId ||
        !statusTaskId ||
        taskId !== contractTaskId ||
        taskId !== statusTaskId ||
        actionTaskStatus === undefined ||
        graphTask.status !== actionTaskStatus ||
        contractDiagnostic.value.activeTask?.status !== actionTaskStatus ||
        kit.status.activeTask?.status !== actionTaskStatus
      ) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_unavailable",
            reason:
              "The canonical action, Kit status, integration contract, and task graph did not identify the same task and status."
          }),
          action
        );
        return;
      }

      const contextArtifact = await bridge.readAuthoritativeContextPackArtifact(
        taskId,
        contractDiagnostic.value
      );
      printWarnings(bridge.warnings);
      if (!contextArtifact) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "context_pack_unavailable",
            reason: `Kit context pack for ${taskId} was unavailable or malformed.`
          }),
          action
        );
        return;
      }

      const adoptionDiagnostic = await prepareStrictKitAdoption(projectPath, {
        action,
        artifact: contextArtifact,
        contract: contractDiagnostic.value
      });
      if (!adoptionDiagnostic.ok) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: adoptionDiagnostic.reasonCode,
            reason: adoptionDiagnostic.reason
          }),
          action
        );
        return;
      }
      const strictKitAdoption = adoptionDiagnostic.value;

      const implementGate = await bridge.gateImplement(taskId);
      printWarnings(bridge.warnings);

      if (!implementGate) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_implement_unavailable",
            reason: "Kit gate-implement evaluation was unavailable or malformed."
          }),
          action
        );
        return;
      }
      if (implementGate.allowed === false) {
        failStrictRun(
          renderAuthoritativeGateBlocked({
            stage: "gate_implement",
            reasonCode: "gate_implement_blocked",
            task: taskId,
            gate: implementGate
          }),
          action
        );
        return;
      }
      if (implementGate.taskId !== taskId) {
        failStrictRun(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "gate_implement_task_mismatch",
            reason: `Kit gate-implement evaluated task ${implementGate.taskId ?? "none"}; expected canonical task ${taskId}.`
          }),
          action
        );
        return;
      }

      // Create durable Hyper session state only after every required strict
      // precondition has produced a valid authoritative result.
      const { handoff, session } = await executeStart(projectPath, action.goal, {
        tool: options.tool,
        authority: { mode: "kit", adoption: strictKitAdoption }
      });

      console.log(handoff);
      console.log("");
      console.log(renderHyperActionFrame(toHyperActionEnvelope(action)));
      await printAndRecordRouting(projectPath, action, session.tool, {
        modelId: options.targetModel,
        modelVersion: options.targetModelVersion
      });
    });
}

/**
 * Compute the advisory model-routing suggestion for `action`, print it after the
 * action block, and persist the decision. Best-effort: a routing failure must
 * never break the run command, so errors are swallowed.
 */
async function printAndRecordRouting(
  projectPath: string,
  action: NormalizedWorkflowAction,
  host: ToolProfile,
  target: { modelId?: string; modelVersion?: string }
): Promise<void> {
  try {
    if (action.task === null) {
      return;
    }
    const task = {
      id: action.task.id,
      taskClass: action.taskClass.state === "available" ? action.taskClass.value : null,
      riskLevel: action.risk.level.state === "available" ? action.risk.level.value : null,
      riskFactors: action.risk.factors.state === "available" ? action.risk.factors.value : null,
      assuranceProfile:
        action.assurance.profile.state === "available"
          ? action.assurance.profile.value
          : null,
      allowedFiles: action.scope.writablePaths
    };
    const [{ data: telemetry }, { state: routingState }, hyperState] = await Promise.all([
      readTelemetry(projectPath),
      readRoutingState(projectPath),
      readState(projectPath)
    ]);
    const suggestion = computeSuggestedTier({
      task,
      cohort: routingCohortForTask({
        host,
        task,
        modelId: target.modelId,
        modelVersion: target.modelVersion
      }),
      attempts: telemetry.attempts,
      routingState,
      sessionCount: Object.keys(hyperState.sessions).length
    });
    console.log("");
    console.log(renderModelRouting(suggestion));
    await recordRoutingDecision(projectPath, {
      taskId: suggestion.taskId,
      taskClass: suggestion.taskClass,
      riskLevel: suggestion.riskLevel,
      riskFactors: suggestion.riskFactors,
      tier: suggestion.suggestedTier,
      reason: suggestion.reason,
      at: new Date().toISOString()
    });
  } catch {
    // Advisory only; never fail the run because routing could not be computed.
  }
}

/**
 * `visp work` is a human verb, and its refusal used to be one fixed sentence
 * regardless of cause. Name what Kit actually reported and which verb fits it,
 * so the stop is an instruction rather than a dead end.
 */
function strictAdoptionRefusalReason(action: NormalizedWorkflowAction): string {
  if (!supportsStrictSessionAdoption(action.source.protocolVersion)) {
    return `Kit is speaking WorkflowAction protocol ${action.source.protocolVersion}, which predates strict session adoption. Upgrade visp-kit.`;
  }
  const phase = action.phase.state === "available" ? action.phase.value : action.sourcePhase;
  if (phase !== "implement") {
    const verb =
      phase === "verify" || phase === "review" || phase === "reconcile"
        ? "visp check"
        : "visp plan";
    return `visp work starts implementation, but Kit reports the workflow is at the ${phase} phase. Run ${verb} to continue from there.`;
  }
  return "Kit's canonical action names no task yet. Run visp plan to advance the workflow until a task is selected.";
}

function failStrictRun(output: string, action?: NormalizedWorkflowAction): void {
  console.log(output);
  if (action) {
    console.log("");
    console.log(renderHyperActionFrame(toHyperActionEnvelope(action)));
  }
  process.exitCode = 1;
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
): Promise<KitAuthoritativeTaskGraph | null> {
  const contractPath = contract.artifacts.taskGraph;
  if (!contractPath || contractPath.includes("<")) {
    return null;
  }
  const expectedSuffix = featureDirName ? `.visp/features/${featureDirName}/task-graph.json` : undefined;
  const normalized = contractPath.replaceAll("\\", "/");
  if (expectedSuffix && !normalized.endsWith(expectedSuffix)) {
    return null;
  }
  const path = isAbsolute(contractPath) ? contractPath : join(projectPath, contractPath);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const result = kitAuthoritativeTaskGraphSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
