import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Command, Option } from "commander";
import { updateActiveSession } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import type { KitGateResult, KitStatus } from "../../kit/kit-schemas.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import {
  buildActionBlock,
  currentTask,
  initialPipelineState,
  loadTaskGraph
} from "../../pipeline/pipeline-engine.js";
import { executeStart } from "./start.js";
import { resolveProjectPath } from "./shared.js";

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

      const contextPackPath = featureDirName
        ? await contextPackPathIfExists(projectPath, featureDirName, task.id)
        : undefined;

      console.log(handoff);
      console.log("");
      console.log(buildActionBlock(task, { contextPackPath, sessionId: session.id }));
    });
}

function deriveFeatureDirName(status: KitStatus): string | undefined {
  const feature = status.activeFeature;
  if (!feature) {
    return undefined;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}

async function contextPackPathIfExists(
  projectPath: string,
  featureDirName: string,
  taskId: string
): Promise<string | undefined> {
  const relative = join(".visp", "features", featureDirName, "context", `${taskId}.context.json`);
  try {
    await stat(join(projectPath, relative));
    return relative;
  } catch {
    return undefined;
  }
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  warnings.length = 0;
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
