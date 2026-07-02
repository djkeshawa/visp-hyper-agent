import { isAbsolute, relative } from "node:path";
import { Command, Option } from "commander";
import { toPosixPath } from "../../core/fs-utils.js";
import { readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import { detectVisp } from "../../kit/kit-command-bridge.js";
import type { KitTask } from "../../kit/kit-schemas.js";
import { buildActionBlock } from "../../pipeline/pipeline-engine.js";
import { ProjectValidationRunner } from "../../quality/validation-runner.js";
import { computeSuggestedTier, renderModelRouting } from "../../routing/routing-engine.js";
import { readRoutingState, recordRoutingDecision } from "../../routing/routing-state.js";
import { readTelemetry } from "../../telemetry/telemetry-store.js";
import { executeStart } from "./start.js";
import { resolveProjectPath } from "./shared.js";

const QUICK_TASK_ID = "Q001";

export function quickCommand(): Command {
  return new Command("quick")
    .description("Zero-config front door: fabricate a one-task pipeline and print the handoff + action block.")
    .argument("<goal>", "Implementation goal.")
    .addOption(new Option("--files <prefix...>", "Allowed file path prefixes for the task."))
    .addOption(
      new Option("--tool <tool>", "Tool profile.")
        .choices(["generic", "codex", "claude-code", "copilot", "opencode"])
    )
    .action(async function (this: Command, goal: string, options: { files?: string[]; tool?: ToolProfile }) {
      const projectPath = resolveProjectPath(this);

      const files = normalizeFiles(options.files ?? [], projectPath);
      const config = await readConfig(projectPath);
      const detected = await new ProjectValidationRunner({
        configCommands: config.validationCommands
      }).detect(projectPath);

      const task: KitTask = {
        id: QUICK_TASK_ID,
        title: goal,
        description: goal,
        dependsOn: [],
        allowedFiles: files.length > 0 ? files : undefined,
        validationCommands: detected.length > 0 ? detected : undefined,
        status: "pending",
        riskLevel: "low"
      };

      const { session, handoff } = await executeStart(projectPath, goal, { tool: options.tool });

      await updateActiveSession(projectPath, (current) => ({
        ...current,
        pipeline: {
          taskIds: [QUICK_TASK_ID],
          currentTaskId: QUICK_TASK_ID,
          completed: [],
          stepHistory: [],
          syntheticTasks: [task]
        }
      }));

      console.log(handoff);
      console.log("");
      console.log(buildActionBlock(task, { sessionId: session.id }));
      await printAndRecordRouting(projectPath, task);

      const kit = await detectVisp(projectPath);
      if (kit.available) {
        console.log("");
        console.log(
          "hint: this project has a Visp Kit — `visp-hyper run` drives the full gated workflow."
        );
      }
    });
}

/**
 * Normalize `--files` entries to project-relative paths: absolute inputs are made
 * relative to `projectPath` and leading `./` is stripped.
 */
function normalizeFiles(files: string[], projectPath: string): string[] {
  return files.map((file) => {
    const rel = isAbsolute(file) ? toPosixPath(relative(projectPath, file)) : file;
    return rel.replace(/^\.\//, "");
  });
}

/**
 * Compute the advisory model-routing suggestion for `task`, print it after the
 * action block, and persist the decision. Best-effort: a routing failure must
 * never break the quick command, so errors are swallowed.
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
    // Advisory only; never fail quick because routing could not be computed.
  }
}
