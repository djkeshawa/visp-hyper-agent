import type { Command } from "commander";
import { resolve } from "node:path";
import { resolveProjectFile } from "../../core/project-path.js";
import type { PipelineGraphIdentity, PipelineState, ToolProfile } from "../../core/types.js";
import type { KitTaskGraph } from "../../kit/kit-schemas.js";
import { computeExecutionTiers, renderWorkflowDirective } from "../../pipeline/workflow-directive.js";

export function resolveProjectPath(command: Command): string {
  const options = command.optsWithGlobals<{ project: string }>();
  return resolve(options.project);
}

/**
 * Print and drain a warnings buffer to stdout. Mutates the array to empty so the
 * same buffer (e.g. a KitCommandBridge's) can be reused across calls without
 * re-printing.
 */
export function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.log(`warning: ${warning}`);
  }
  warnings.length = 0;
}

/**
 * Return the project-relative path to a task's Kit context pack when the
 * pipeline is pinned to an exact Kit graph. Bare task ids are deliberately not
 * searched across features because ids such as T001 routinely repeat.
 */
export async function contextPackPathIfExists(
  projectPath: string,
  taskId: string,
  graphIdentity?: PipelineGraphIdentity
): Promise<string | undefined> {
  if (graphIdentity?.kind !== "visp-kit") {
    return undefined;
  }

  const normalizedSource = graphIdentity.source.replaceAll("\\", "/").replace(/^\.\//, "");
  const match = /^\.visp\/features\/([^/]+)\/task-graph\.json$/.exec(normalizedSource);
  if (!match?.[1]) {
    return undefined;
  }

  const relative = `.visp/features/${match[1]}/context/${taskId}.context.json`;
  try {
    const resolved = await resolveProjectFile(projectPath, relative, {
      mode: "read",
      blockedPaths: []
    });
    return resolved.logicalPath;
  } catch {
    return undefined;
  }
}

export function renderPipelineComplete(input: {
  sessionId?: string;
  feature?: string;
  completedTasks: readonly string[];
}): string {
  return [
    "BEGIN_VISP_PIPELINE_COMPLETE",
    "status: COMPLETE",
    ...(input.sessionId ? [`session_id: ${input.sessionId}`] : []),
    ...(input.feature ? [`feature: ${input.feature}`] : []),
    `completed_tasks: ${input.completedTasks.length > 0 ? input.completedTasks.join(", ") : "none"}`,
    "instruction: No pipeline task remains to run or checkpoint.",
    "END_VISP_PIPELINE_COMPLETE"
  ].join("\n");
}

export function renderPipelineIdentityStop(input: {
  sessionId: string;
  reasonCode: string;
  reason: string;
}): string {
  return [
    "BEGIN_VISP_PIPELINE_STATE",
    `session_id: ${input.sessionId}`,
    "status: INCONCLUSIVE",
    `reason_code: ${input.reasonCode}`,
    `reason: ${input.reason}`,
    "instruction: Start a fresh run or quick session; this pipeline cannot safely infer another graph.",
    "END_VISP_PIPELINE_STATE"
  ].join("\n");
}


/**
 * Print the advisory fan-out directive when the remaining DAG has independent
 * parallelizable tasks. Best-effort and silent otherwise — sequential graphs
 * and single-task pipelines produce no extra output.
 */
export function printWorkflowDirectiveIfAny(
  graph: KitTaskGraph,
  pipeline: PipelineState,
  tool: ToolProfile,
  sessionId: string
): void {
  try {
    const directive = renderWorkflowDirective({
      tiers: computeExecutionTiers(graph, pipeline),
      tool,
      sessionId
    });
    if (directive) {
      console.log("");
      console.log(directive);
    }
  } catch {
    // Advisory only; never fail the command because the directive could not be computed.
  }
}
