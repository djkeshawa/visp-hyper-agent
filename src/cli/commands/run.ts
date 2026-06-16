import { Command, Option } from "commander";
import { readState, updateActiveSession } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import type { KitGateResult, KitStatus } from "../../kit/kit-schemas.js";
import type { KitTask } from "../../kit/kit-schemas.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import {
  buildActionBlock,
  currentTask,
  initialPipelineState,
  loadTaskGraph
} from "../../pipeline/pipeline-engine.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { executeStart } from "./start.js";
import { contextPackPathIfExists, printWarnings, resolveProjectPath } from "./shared.js";

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

      // Kit-less: behave exactly like `start`.
      if (!kit.available) {
        const { handoff } = await executeStart(projectPath, goal, options);
        console.log(handoff);
        return;
      }

      printWarnings(kit.warnings);

      const bridge = new KitCommandBridge({ projectPath });

      const policy = await bridge.policyValidate();
      printWarnings(bridge.warnings);
      if (policy && !policy.success) {
        console.log(renderPolicyBlocked(policy.errors));
        return;
      }

      const gateState = await bridge.gate("next");
      printWarnings(bridge.warnings);

      const featureDirName = deriveFeatureDirName(kit.status);
      const graph = await loadTaskGraph(projectPath, featureDirName);

      // Always run the start flow so the session and context/memory packs exist.
      const { session, handoff } = await executeStart(projectPath, goal, options);

      if (!graph) {
        console.log(handoff);
        console.log("");
        console.log(renderPipelineBlocked({ task: undefined, gate: gateState, bridge: await bridge.next() }));
        printWarnings(bridge.warnings);
        return;
      }

      const pipeline = initialPipelineState(graph);
      await updateActiveSession(projectPath, (current) => ({ ...current, pipeline }));

      const task = currentTask(graph, pipeline);
      if (!task) {
        console.log(handoff);
        console.log("");
        console.log(renderPipelineBlocked({ task: undefined, gate: gateState, bridge: await bridge.next() }));
        printWarnings(bridge.warnings);
        return;
      }

      const implementGate = await bridge.gateImplement(task.id);
      printWarnings(bridge.warnings);

      // Fail closed: an unparseable gate result is unknown state, not permission.
      if (!implementGate || implementGate.allowed === false) {
        console.log(handoff);
        console.log("");
        console.log(renderPipelineBlocked({ task: task.id, gate: implementGate, bridge: await bridge.next() }));
        printWarnings(bridge.warnings);
        return;
      }

      const pack = await bridge.readContextPack(task.id);
      printWarnings(bridge.warnings);
      if (!pack) {
        console.log(handoff);
        console.log("");
        console.log(renderPipelineBlocked({ task: task.id, gate: implementGate, bridge: await bridge.next() }));
        printWarnings(bridge.warnings);
        return;
      }

      const contextPackPath = await contextPackPathIfExists(projectPath, task.id);

      console.log(handoff);
      console.log("");
      console.log(buildActionBlock(task, { contextPackPath, sessionId: session.id }));
      await printAndRecordRouting(projectPath, task);
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

function renderPolicyBlocked(errors: string[]): string {
  const lines = ["BEGIN_VISP_POLICY_BLOCKED"];
  if (errors.length > 0) {
    lines.push("errors:");
    for (const error of errors) {
      lines.push(`  - ${error}`);
    }
  } else {
    lines.push("errors:");
    lines.push("  - Policy validation failed.");
  }
  lines.push("instruction: Resolve the policy errors above with your coding agent, then re-run `visp-hyper run`.");
  lines.push("END_VISP_POLICY_BLOCKED");
  return lines.join("\n");
}

function renderPipelineBlocked(input: {
  task: string | undefined;
  gate: KitGateResult | null;
  bridge: { nextCommand?: string } | null;
}): string {
  const lines = ["BEGIN_VISP_PIPELINE_BLOCKED", "stage: implement"];
  lines.push(`task: ${input.task ?? "none"}`);
  lines.push("failed_rules:");
  const failedRules = input.gate?.failedRules ?? [];
  if (failedRules.length > 0) {
    for (const rule of failedRules) {
      const message = "message" in rule ? rule.message ?? "" : "";
      lines.push(`  - ${rule.ruleId}: ${message}`.trimEnd());
    }
  } else {
    lines.push("  - none");
  }
  const nextAllowed = input.gate?.nextAllowedCommand ?? input.bridge?.nextCommand ?? "visp tasks";
  lines.push(`next_allowed_command: ${nextAllowed}`);
  lines.push("instruction: Run the command above with your coding agent, then re-run `visp-hyper run`.");
  lines.push("END_VISP_PIPELINE_BLOCKED");
  return lines.join("\n");
}
