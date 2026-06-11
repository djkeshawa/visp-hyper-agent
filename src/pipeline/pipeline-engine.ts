import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { kitTaskGraphSchema, type KitTask, type KitTaskGraph } from "../kit/kit-schemas.js";
import { discoverPlanTaskGraph } from "../plan/plan-readers.js";
import type { PipelineState } from "../core/types.js";

const COMPLETED_STATUSES = new Set(["verified", "done"]);

/**
 * Locate and parse a feature's `.visp` `task-graph.json`. Never throws: a
 * missing directory, missing file, unreadable file, or invalid JSON all resolve
 * to `null`. When multiple feature directories exist, the one matching
 * `featureDirName` is preferred, otherwise the last directory in sorted order
 * (i.e. the highest feature number) is used. This is the visp-kit path only —
 * the loose plan-file fallback lives in {@link loadTaskGraphDetailed}.
 */
async function loadVispKitTaskGraph(
  projectPath: string,
  featureDirName?: string
): Promise<KitTaskGraph | null> {
  const featureRoot = join(projectPath, ".visp", "features");

  let dirNames: string[];
  try {
    const entries = await readdir(featureRoot, { withFileTypes: true });
    dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return null;
  }

  if (dirNames.length === 0) {
    return null;
  }

  let chosen: string | undefined;
  if (featureDirName && dirNames.includes(featureDirName)) {
    chosen = featureDirName;
  } else {
    chosen = dirNames[dirNames.length - 1];
  }

  if (!chosen) {
    return null;
  }

  let raw: string;
  try {
    raw = await readFile(join(featureRoot, chosen, "task-graph.json"), "utf8");
  } catch {
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const result = kitTaskGraphSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Detailed task-graph resolution. The visp-kit scan runs first and unchanged;
 * only when it yields `null` does the loose plan-file fallback
 * ({@link discoverPlanTaskGraph}) run. `source` is `"visp-kit"` for the kit
 * path, the plan reader's source string for a fallback, or `null` when nothing
 * matched. Never throws.
 */
export async function loadTaskGraphDetailed(
  projectPath: string,
  featureDirName?: string
): Promise<{ graph: KitTaskGraph | null; source: string | null; warnings: string[] }> {
  const kitGraph = await loadVispKitTaskGraph(projectPath, featureDirName);
  if (kitGraph) {
    return { graph: kitGraph, source: "visp-kit", warnings: [] };
  }

  try {
    return await discoverPlanTaskGraph(projectPath);
  } catch {
    return { graph: null, source: null, warnings: [] };
  }
}

/**
 * Locate and parse a task graph, preferring the visp-kit `task-graph.json` and
 * falling back to loose plan files (`PLAN.md`/`TODO.md`/`tasks.md`, Spec Kit,
 * OpenSpec) when no kit graph exists. Never throws; returns `null` when nothing
 * parseable is found. Signature preserved for existing callers — use
 * {@link loadTaskGraphDetailed} when the source/warnings are needed.
 */
export async function loadTaskGraph(
  projectPath: string,
  featureDirName?: string
): Promise<KitTaskGraph | null> {
  const { graph } = await loadTaskGraphDetailed(projectPath, featureDirName);
  return graph;
}

/**
 * Deterministic topological sort honoring `dependsOn`. Among ready tasks the
 * original graph order is preserved (stable). Dependency ids that do not match
 * any task in the graph are treated as already satisfied. On a cycle, returns
 * `ordered: []` and `cycle` listing the task ids that remain unresolved.
 */
export function orderTasks(graph: KitTaskGraph): { ordered: KitTask[]; cycle: string[] | null } {
  const tasks = graph.tasks;
  const known = new Set(tasks.map((task) => task.id));
  const placed = new Set<string>();
  const ordered: KitTask[] = [];

  let progress = true;
  while (ordered.length < tasks.length && progress) {
    progress = false;
    for (const task of tasks) {
      if (placed.has(task.id)) {
        continue;
      }
      const ready = task.dependsOn.every((dep) => !known.has(dep) || placed.has(dep));
      if (ready) {
        ordered.push(task);
        placed.add(task.id);
        progress = true;
      }
    }
  }

  if (ordered.length < tasks.length) {
    const cycle = tasks.filter((task) => !placed.has(task.id)).map((task) => task.id);
    return { ordered: [], cycle };
  }

  return { ordered, cycle: null };
}

/**
 * Build the starting pipeline state from a task graph. Tasks already marked
 * `verified`/`done` are recorded as completed; `currentTaskId` is the first
 * ordered task not yet completed (or `null` when all are complete). On a cycle,
 * `taskIds` falls back to the graph order and `currentTaskId` is `null`.
 */
export function initialPipelineState(graph: KitTaskGraph): PipelineState {
  const { ordered, cycle } = orderTasks(graph);

  if (cycle) {
    return {
      taskIds: graph.tasks.map((task) => task.id),
      currentTaskId: null,
      completed: [],
      stepHistory: []
    };
  }

  const completed: string[] = [];
  let currentTaskId: string | null = null;
  for (const task of ordered) {
    if (task.status && COMPLETED_STATUSES.has(task.status)) {
      completed.push(task.id);
    } else if (currentTaskId === null) {
      currentTaskId = task.id;
    }
  }

  return {
    taskIds: ordered.map((task) => task.id),
    currentTaskId,
    completed,
    stepHistory: []
  };
}

export function currentTask(graph: KitTaskGraph, state: PipelineState): KitTask | null {
  if (!state.currentTaskId) {
    return null;
  }
  return graph.tasks.find((task) => task.id === state.currentTaskId) ?? null;
}

export type CheckpointEvidence = {
  verifyPassed: boolean;
  reviewPassed: boolean;
  detail?: string;
};

/**
 * Pure transition: returns a new `PipelineState`. When both verify and review
 * passed, the current task is recorded as `checkpoint-passed`, moved into
 * `completed`, and `currentTaskId` advances to the next ordered task not already
 * completed (`null` when exhausted). Any failure records `checkpoint-failed`
 * and keeps `currentTaskId`. With no current task the state is returned
 * unchanged.
 */
export function advance(
  state: PipelineState,
  graph: KitTaskGraph,
  evidence: CheckpointEvidence,
  now: string
): PipelineState {
  if (!state.currentTaskId) {
    return state;
  }

  const passed = evidence.verifyPassed && evidence.reviewPassed;
  const current = state.currentTaskId;

  if (!passed) {
    return {
      ...state,
      taskIds: [...state.taskIds],
      completed: [...state.completed],
      stepHistory: [
        ...state.stepHistory,
        { taskId: current, action: "checkpoint-failed", at: now, detail: evidence.detail }
      ]
    };
  }

  const completed = [...state.completed, current];
  const { ordered } = orderTasks(graph);
  const orderedIds = ordered.length > 0 ? ordered.map((task) => task.id) : state.taskIds;
  const nextTaskId = orderedIds.find((id) => !completed.includes(id)) ?? null;

  return {
    ...state,
    taskIds: [...state.taskIds],
    currentTaskId: nextTaskId,
    completed,
    stepHistory: [
      ...state.stepHistory,
      { taskId: current, action: "checkpoint-passed", at: now, detail: evidence.detail }
    ]
  };
}

/**
 * Render the bounded, deterministic task-action text block. Sections with no
 * data are omitted. Style mirrors the handoff protocol renderer.
 */
export function buildActionBlock(
  task: KitTask,
  options: { contextPackPath?: string; sessionId?: string } = {}
): string {
  const lines: string[] = ["BEGIN_VISP_TASK_ACTION"];

  lines.push(`task: ${task.id}${task.title ? ` - ${task.title}` : ""}`);
  lines.push(
    `risk: ${task.riskLevel ?? "unknown"}    parallelizable: ${task.parallelizable === true ? "true" : "false"}`
  );
  if (options.sessionId) {
    lines.push(`session: ${options.sessionId}`);
  }

  lines.push("");
  lines.push("goal:");
  lines.push(`  ${task.description ?? task.title ?? task.id}`);

  if (task.allowedFiles && task.allowedFiles.length > 0) {
    lines.push("");
    lines.push("allowed_files:");
    for (const file of task.allowedFiles) {
      lines.push(`  - ${file}`);
    }
  }

  if (task.forbiddenFiles && task.forbiddenFiles.length > 0) {
    lines.push("");
    lines.push("forbidden_files:");
    for (const file of task.forbiddenFiles) {
      lines.push(`  - ${file}`);
    }
  }

  if (task.acceptanceCriterionIds && task.acceptanceCriterionIds.length > 0) {
    lines.push("");
    lines.push("acceptance_criteria:");
    for (const criterion of task.acceptanceCriterionIds) {
      lines.push(`  - ${criterion}`);
    }
  }

  if (task.validationCommands && task.validationCommands.length > 0) {
    lines.push("");
    lines.push("validation_commands:");
    for (const command of task.validationCommands) {
      lines.push(`  - ${command}`);
    }
  }

  if (options.contextPackPath) {
    lines.push("");
    lines.push(`context_pack: ${options.contextPackPath}`);
  }

  lines.push("");
  lines.push("done_criteria:");
  lines.push("  1. All validation commands exit zero.");
  lines.push("  2. Only allowed or expected files changed.");
  lines.push(
    `  3. Run \`visp-hyper checkpoint --task ${task.id}\` and proceed only if it reports PASSED.`
  );
  lines.push("END_VISP_TASK_ACTION");

  return lines.join("\n");
}
