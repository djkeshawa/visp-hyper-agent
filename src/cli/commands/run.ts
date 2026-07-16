import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readState, updateActiveSession } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import {
  kitAuthoritativeTaskGraphSchema,
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
  readySet
} from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { executeStart, prepareStrictKitAdoption } from "./start.js";
import { contextPackPathIfExists, printWarnings, printWorkflowDirectiveIfAny, resolveProjectPath } from "./shared.js";

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
        const { handoff } = await executeStart(projectPath, goal, options);
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
      const graph = await loadConfiguredTaskGraph(
        projectPath,
        contractDiagnostic.value,
        featureDirName
      );

      if (!graph) {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: "task_graph_unavailable",
            reason: "The configured Kit task graph was unavailable or malformed."
          })
        );
        return;
      }

      const pipeline = initialPipelineState(graph);
      const task = currentTask(graph, pipeline);
      const contractTaskId = contractDiagnostic.value.activeTask?.id;
      const statusTaskId = kit.status.activeTask?.id;
      if (!task || !contractTaskId || !statusTaskId || task.id !== contractTaskId || task.id !== statusTaskId) {
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
        strictKit: { adoption: strictKitAdoption }
      });
      await updateActiveSession(projectPath, (current) => ({ ...current, pipeline }));

      const contextPackPath = await contextPackPathIfExists(projectPath, task.id);
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
