import type { Command } from "commander";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PipelineState, ToolProfile } from "../../core/types.js";
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
 * Return the project-relative path to a task's kit context pack if it exists.
 * Scans every feature directory (not just a derived name) so the lookup does not
 * silently miss a pack when the on-disk directory diverges from the derived one.
 */
export async function contextPackPathIfExists(
  projectPath: string,
  taskId: string
): Promise<string | undefined> {
  const featureRoot = join(projectPath, ".visp", "features");
  let dirNames: string[];
  try {
    const entries = await readdir(featureRoot, { withFileTypes: true });
    dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return undefined;
  }
  for (const dirName of dirNames) {
    const relative = join(".visp", "features", dirName, "context", `${taskId}.context.json`);
    try {
      await stat(join(projectPath, relative));
      return relative;
    } catch {
      // try next feature directory
    }
  }
  return undefined;
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
