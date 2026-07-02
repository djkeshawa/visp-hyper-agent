import type { KitTask, KitTaskGraph } from "../kit/kit-schemas.js";
import type { PipelineState, ToolProfile } from "../core/types.js";

/**
 * One execution tier: a dependency layer of the remaining DAG, split into the
 * tasks qualified for concurrent implementation and the rest.
 */
export type ExecutionTier = {
  parallel: KitTask[];
  sequential: KitTask[];
};

// A directive only prints when a tier has at least this many parallel tasks.
const MIN_PARALLEL_TASKS = 2;

const DIRECTIVE_VERSION = "0.1";

/**
 * Per-tool consumption hints. claude-code gets the native fan-out wording;
 * every other profile gets an explicitly sequential interpretation, so the
 * same block is safe for tools with no subagent primitive.
 */
const directiveToolHints: Record<ToolProfile, string[]> = {
  "claude-code": [
    "Dispatch each parallel task to a separate implementer subagent via the Task tool.",
    "Give each subagent its task's BEGIN_VISP_TASK_ACTION block verbatim; it must stay strictly inside that task's allowed_files.",
    "The coordinator (you) runs the checkpoints sequentially after the subagents return."
  ],
  codex: [
    "Execute the tasks in the listed order; treat the parallel grouping as safe-to-reorder, not as a concurrency requirement.",
    "Checkpoint each task before starting the next."
  ],
  copilot: [
    "Execute the tasks in the listed order; treat the parallel grouping as safe-to-reorder, not as a concurrency requirement.",
    "Checkpoint each task before starting the next."
  ],
  opencode: [
    "Execute the tasks in the listed order; treat the parallel grouping as safe-to-reorder, not as a concurrency requirement.",
    "Checkpoint each task before starting the next."
  ],
  generic: [
    "Execute the tasks in the listed order; treat the parallel grouping as safe-to-reorder, not as a concurrency requirement.",
    "Checkpoint each task before starting the next."
  ]
};

/**
 * Deterministic Kahn layering of the incomplete tasks. Within a layer, a task
 * qualifies for the parallel set only when it is explicitly marked
 * `parallelizable` AND its `allowedFiles` scope is pairwise-disjoint with
 * every other parallel candidate in the layer — a missing `allowedFiles`
 * means unbounded scope and never parallelizes. Task order is stable
 * (graph order within a layer).
 */
export function computeExecutionTiers(graph: KitTaskGraph, state: PipelineState): ExecutionTier[] {
  const completed = new Set(state.completed);
  const remaining = graph.tasks.filter((task) => !completed.has(task.id));
  const remainingIds = new Set(remaining.map((task) => task.id));

  const tiers: ExecutionTier[] = [];
  const placed = new Set<string>();

  while (placed.size < remaining.length) {
    const layer = remaining.filter(
      (task) =>
        !placed.has(task.id) &&
        task.dependsOn.every((dep) => !remainingIds.has(dep) || placed.has(dep))
    );
    if (layer.length === 0) {
      // Cycle among the remaining tasks: fall back to one sequential tier so
      // the directive never renders a bogus parallel plan.
      const leftover = remaining.filter((task) => !placed.has(task.id));
      tiers.push({ parallel: [], sequential: leftover });
      break;
    }

    const candidates = layer.filter(
      (task) => task.parallelizable === true && (task.allowedFiles?.length ?? 0) > 0
    );
    const parallel = candidates.filter((task) =>
      candidates.every((other) => other.id === task.id || disjointScopes(task.allowedFiles!, other.allowedFiles!))
    );
    const parallelIds = new Set(parallel.map((task) => task.id));
    tiers.push({
      parallel: parallel.length >= MIN_PARALLEL_TASKS ? parallel : [],
      sequential: layer.filter((task) => parallel.length >= MIN_PARALLEL_TASKS ? !parallelIds.has(task.id) : true)
    });
    for (const task of layer) {
      placed.add(task.id);
    }
  }

  return tiers;
}

/**
 * Render the advisory fan-out directive, or `null` when no tier qualifies —
 * sequential graphs and single-task pipelines produce no output at all, so
 * existing flows are byte-identical.
 */
export function renderWorkflowDirective(input: {
  tiers: ExecutionTier[];
  tool: ToolProfile;
  sessionId: string;
}): string | null {
  const hasParallel = input.tiers.some((tier) => tier.parallel.length >= MIN_PARALLEL_TASKS);
  if (!hasParallel) {
    return null;
  }

  const lines: string[] = [
    "BEGIN_VISP_WORKFLOW_DIRECTIVE",
    `version: ${DIRECTIVE_VERSION}`,
    `session: ${input.sessionId}`,
    "mode: parallel-capable",
    "tiers:"
  ];

  let ordinal = 0;
  const checkpointOrder: string[] = [];
  for (const tier of input.tiers) {
    if (tier.parallel.length > 0) {
      ordinal += 1;
      lines.push(
        `  ${ordinal}. parallel: ${tier.parallel.map((task) => task.id).join(", ")} (disjoint file scopes, parallelizable)`
      );
      checkpointOrder.push(...tier.parallel.map((task) => task.id));
    }
    if (tier.sequential.length > 0) {
      ordinal += 1;
      lines.push(`  ${ordinal}. sequential: ${tier.sequential.map((task) => task.id).join(", ")}`);
      checkpointOrder.push(...tier.sequential.map((task) => task.id));
    }
  }

  lines.push("execution_plan:");
  lines.push("  - Implement each parallel tier's tasks concurrently; every task stays strictly inside its allowed_files.");
  lines.push(
    `  - Checkpoints remain sequential: run \`visp-hyper checkpoint --task <id>\` in this order only: ${checkpointOrder.join(", ")}.`
  );
  lines.push("  - Do not start a later tier until every earlier task reports PASSED.");

  lines.push("tool_hint:");
  for (const hint of directiveToolHints[input.tool]) {
    lines.push(`  - ${hint}`);
  }

  lines.push("END_VISP_WORKFLOW_DIRECTIVE");
  return lines.join("\n");
}

/**
 * Two allowed-files scopes are disjoint when no entry of one equals or
 * path-prefixes an entry of the other (matching the scope-guard semantics of
 * exact-or-`<entry>/` prefixes).
 */
function disjointScopes(a: readonly string[], b: readonly string[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        return false;
      }
    }
  }
  return true;
}
