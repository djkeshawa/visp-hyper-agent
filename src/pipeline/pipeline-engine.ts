import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { kitTaskGraphSchema, type KitTask, type KitTaskGraph } from "../kit/kit-schemas.js";
import { resolveProjectFile } from "../core/project-path.js";
import { discoverPlanTaskGraph, readPlanTaskGraphSource } from "../plan/plan-readers.js";
import type { PipelineGraphIdentity, PipelineState } from "../core/types.js";

const COMPLETED_STATUSES = new Set(["verified", "done"]);

export type TaskGraphValidationResult =
  | { ok: true; ordered: KitTask[] }
  | { ok: false; reasonCode: "task_graph_invalid"; reason: string; errors: string[]; cycle: string[] | null };

export type TaskGraphLoadResult =
  | { ok: true; graph: KitTaskGraph }
  | {
      ok: false;
      reasonCode:
        | "graph_identity_invalid"
        | "task_graph_missing"
        | "task_graph_invalid"
        | "task_graph_identity_mismatch";
      reason: string;
    };

export type PipelineStateValidationResult =
  | { ok: true }
  | {
      ok: false;
      reasonCode:
        | "pipeline_identity_missing"
        | "pipeline_graph_mismatch"
        | "pipeline_state_invalid";
      reason: string;
    };

type VispKitGraphAttempt =
  | { status: "loaded"; graph: KitTaskGraph; source: string }
  | { status: "absent" }
  | { status: "missing" | "invalid"; source: string; reason: string };

function topologicalOrder(tasks: readonly KitTask[]): { ordered: KitTask[]; cycle: string[] | null } {
  const placed = new Set<string>();
  const ordered: KitTask[] = [];

  let progress = true;
  while (ordered.length < tasks.length && progress) {
    progress = false;
    for (const task of tasks) {
      if (placed.has(task.id)) {
        continue;
      }
      if (task.dependsOn.every((dependency) => placed.has(dependency))) {
        ordered.push(task);
        placed.add(task.id);
        progress = true;
      }
    }
  }

  if (ordered.length < tasks.length) {
    return {
      ordered: [],
      cycle: tasks.filter((task) => !placed.has(task.id)).map((task) => task.id)
    };
  }
  return { ordered, cycle: null };
}

/** Validate the semantic invariants needed for deterministic graph execution. */
export function validateTaskGraph(graph: KitTaskGraph): TaskGraphValidationResult {
  const errors: string[] = [];
  if (graph.tasks.length === 0) {
    errors.push("task graph must contain at least one task");
  }

  const known = new Set<string>();
  for (const [index, task] of graph.tasks.entries()) {
    if (task.id.trim().length === 0) {
      errors.push(`task at index ${index} has an empty id`);
      continue;
    }
    if (task.id !== task.id.trim()) {
      errors.push(`task id ${JSON.stringify(task.id)} must be trimmed`);
    }
    if (known.has(task.id)) {
      errors.push(`duplicate task id: ${task.id}`);
    }
    known.add(task.id);
  }

  for (const task of graph.tasks) {
    const dependencies = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (dependency.trim().length === 0) {
        errors.push(`task ${task.id || "<empty>"} has an empty dependency id`);
        continue;
      }
      if (dependency !== dependency.trim()) {
        errors.push(`dependency ${JSON.stringify(dependency)} on task ${task.id} must be trimmed`);
      }
      if (dependencies.has(dependency)) {
        errors.push(`task ${task.id} repeats dependency ${dependency}`);
      }
      dependencies.add(dependency);
      if (dependency === task.id) {
        errors.push(`task ${task.id} cannot depend on itself`);
      } else if (!known.has(dependency)) {
        errors.push(`task ${task.id} depends on unknown task ${dependency}`);
      }
    }
  }

  const completedTaskIds = new Set(
    graph.tasks
      .filter((task) => COMPLETED_STATUSES.has(task.status ?? ""))
      .map((task) => task.id)
  );
  for (const task of graph.tasks) {
    if (!completedTaskIds.has(task.id)) {
      continue;
    }
    const unfinishedDependency = task.dependsOn.find(
      (dependency) => known.has(dependency) && !completedTaskIds.has(dependency)
    );
    if (unfinishedDependency) {
      errors.push(`completed task ${task.id} has an unfinished dependency ${unfinishedDependency}`);
    }
  }

  let cycle: string[] | null = null;
  let ordered: KitTask[] = [];
  if (errors.length === 0) {
    const result = topologicalOrder(graph.tasks);
    cycle = result.cycle;
    ordered = result.ordered;
    if (cycle) {
      errors.push(`dependency cycle detected among tasks: ${cycle.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      reasonCode: "task_graph_invalid",
      reason: errors.join("; "),
      errors,
      cycle
    };
  }
  return { ok: true, ordered };
}

function graphIdentityError(graph: KitTaskGraph, identity: PipelineGraphIdentity): string | null {
  if (identity.source.trim().length === 0 || identity.source !== identity.source.trim()) {
    return "graph identity source must be a non-empty trimmed string";
  }
  if (identity.kind === "visp-kit") {
    if (!identity.featureId?.trim() || !identity.featureSlug?.trim()) {
      return "visp-kit graph identity requires featureId and featureSlug";
    }
    const expectedSource = `.visp/features/${identity.featureId}-${identity.featureSlug}/task-graph.json`;
    if (identity.source !== expectedSource) {
      return `visp-kit graph source ${identity.source} does not match feature ${identity.featureId}-${identity.featureSlug}`;
    }
  }
  if (graph.featureId !== identity.featureId || graph.featureSlug !== identity.featureSlug) {
    return "loaded task graph does not match the persisted feature identity";
  }
  return null;
}

/** Opaque graph-scoped task key. Consumers compare it but never parse it. */
export function taskKeyFor(identity: PipelineGraphIdentity, taskId: string): string {
  return JSON.stringify([
    identity.kind,
    identity.source,
    identity.featureId ?? null,
    identity.featureSlug ?? null,
    taskId
  ]);
}

export function taskKeysForGraph(
  graph: KitTaskGraph,
  identity: PipelineGraphIdentity
): Record<string, string> {
  return Object.fromEntries(graph.tasks.map((task) => [task.id, taskKeyFor(identity, task.id)]));
}

function taskFingerprintPayload(task: KitTask): unknown {
  return {
    id: task.id,
    title: task.title ?? null,
    description: task.description ?? null,
    requirementIds: task.requirementIds ?? null,
    acceptanceCriterionIds: task.acceptanceCriterionIds ?? null,
    dependsOn: task.dependsOn,
    allowedFiles: task.allowedFiles ?? null,
    expectedFiles: task.expectedFiles ?? null,
    forbiddenFiles: task.forbiddenFiles ?? null,
    validationCommands: task.validationCommands ?? null,
    status: task.status ?? null,
    parallelizable: task.parallelizable ?? null,
    riskLevel: task.riskLevel ?? null
  };
}

function fingerprintPayload(graph: KitTaskGraph): unknown {
  return {
    featureId: graph.featureId ?? null,
    featureSlug: graph.featureSlug ?? null,
    tasks: graph.tasks.map(taskFingerprintPayload)
  };
}

export function graphFingerprintFor(graph: KitTaskGraph): string {
  return createHash("sha256").update(JSON.stringify(fingerprintPayload(graph))).digest("hex");
}

function taskFingerprintFor(task: KitTask): string {
  return createHash("sha256").update(JSON.stringify(taskFingerprintPayload(task))).digest("hex");
}

function injectedTaskFingerprintsFor(tasks: readonly KitTask[]): Record<string, string> {
  return Object.fromEntries(tasks.map((task) => [task.id, taskFingerprintFor(task)]));
}

/** Pin the exact remediation definitions before writing an adapted pipeline. */
export function pinInjectedTaskIntegrity(state: PipelineState): PipelineState {
  return {
    ...state,
    injectedTaskFingerprints: injectedTaskFingerprintsFor(state.injectedTasks ?? [])
  };
}

async function readJsonTaskGraph(projectPath: string, source: string): Promise<TaskGraphLoadResult> {
  let raw: string;
  try {
    const resolved = await resolveProjectFile(projectPath, source, { mode: "read", blockedPaths: [] });
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      reasonCode: "task_graph_missing",
      reason: `The pinned task graph is missing or unreadable: ${source}`
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reasonCode: "task_graph_invalid",
      reason: `The pinned task graph contains invalid JSON: ${source}`
    };
  }
  const schemaResult = kitTaskGraphSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      reasonCode: "task_graph_invalid",
      reason: `The pinned task graph has an invalid shape: ${source}`
    };
  }
  const validation = validateTaskGraph(schemaResult.data);
  if (!validation.ok) {
    return { ok: false, reasonCode: validation.reasonCode, reason: validation.reason };
  }
  return { ok: true, graph: schemaResult.data };
}

/**
 * Load only the graph named by persisted pipeline identity. This is a resume
 * operation, not discovery: missing or invalid sources never fall through to a
 * newer feature or a different plan convention.
 */
export async function loadTaskGraphByIdentity(
  projectPath: string,
  identity: PipelineGraphIdentity,
  syntheticTasks?: readonly KitTask[]
): Promise<TaskGraphLoadResult> {
  if (identity.source.trim().length === 0 || identity.source !== identity.source.trim()) {
    return {
      ok: false,
      reasonCode: "graph_identity_invalid",
      reason: "The persisted graph source is empty or not trimmed."
    };
  }

  let result: TaskGraphLoadResult;
  if (identity.kind === "synthetic") {
    if (!syntheticTasks || syntheticTasks.length === 0) {
      return {
        ok: false,
        reasonCode: "task_graph_missing",
        reason: "The persisted synthetic task graph is missing."
      };
    }
    const graph: KitTaskGraph = {
      ...(identity.featureId ? { featureId: identity.featureId } : {}),
      ...(identity.featureSlug ? { featureSlug: identity.featureSlug } : {}),
      tasks: [...syntheticTasks]
    };
    const validation = validateTaskGraph(graph);
    result = validation.ok
      ? { ok: true, graph }
      : { ok: false, reasonCode: validation.reasonCode, reason: validation.reason };
  } else if (identity.kind === "plan") {
    const plan = await readPlanTaskGraphSource(projectPath, identity.source);
    if (!plan.graph) {
      result = {
        ok: false,
        reasonCode: plan.failureReason === "missing" ? "task_graph_missing" : "task_graph_invalid",
        reason: plan.warnings[0] ?? `The pinned plan graph could not be loaded: ${identity.source}`
      };
    } else {
      const validation = validateTaskGraph(plan.graph);
      result = validation.ok
        ? { ok: true, graph: plan.graph }
        : { ok: false, reasonCode: validation.reasonCode, reason: validation.reason };
    }
  } else {
    if (!identity.featureId?.trim() || !identity.featureSlug?.trim()) {
      return {
        ok: false,
        reasonCode: "graph_identity_invalid",
        reason: "A visp-kit graph identity requires featureId and featureSlug."
      };
    }
    const expectedSource = `.visp/features/${identity.featureId}-${identity.featureSlug}/task-graph.json`;
    if (identity.source !== expectedSource) {
      return {
        ok: false,
        reasonCode: "graph_identity_invalid",
        reason: `The pinned graph source does not match the persisted feature: ${identity.source}`
      };
    }
    result = await readJsonTaskGraph(projectPath, identity.source);
  }

  if (!result.ok) {
    return result;
  }
  const mismatch = graphIdentityError(result.graph, identity);
  if (mismatch) {
    return { ok: false, reasonCode: "task_graph_identity_mismatch", reason: mismatch };
  }
  return result;
}

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
): Promise<VispKitGraphAttempt> {
  const featureRoot = join(projectPath, ".visp", "features");

  let dirNames: string[];
  try {
    const entries = await readdir(featureRoot, { withFileTypes: true });
    dirNames = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return featureDirName
      ? {
          status: "missing",
          source: `.visp/features/${featureDirName}/task-graph.json`,
          reason: `named feature directory is missing: ${featureDirName}`
        }
      : { status: "absent" };
  }

  if (dirNames.length === 0) {
    return featureDirName
      ? {
          status: "missing",
          source: `.visp/features/${featureDirName}/task-graph.json`,
          reason: `named feature directory is missing: ${featureDirName}`
        }
      : { status: "absent" };
  }

  if (featureDirName && !dirNames.includes(featureDirName)) {
    return {
      status: "missing",
      source: `.visp/features/${featureDirName}/task-graph.json`,
      reason: `named feature directory is missing: ${featureDirName}`
    };
  }
  const chosen = featureDirName ?? dirNames[dirNames.length - 1];

  if (!chosen) {
    return { status: "absent" };
  }
  const source = `.visp/features/${chosen}/task-graph.json`;

  let raw: string;
  try {
    const resolved = await resolveProjectFile(projectPath, source, { mode: "read", blockedPaths: [] });
    raw = await readFile(resolved.absolutePath, "utf8");
  } catch {
    return { status: "missing", source, reason: `task graph is missing or unreadable: ${source}` };
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { status: "invalid", source, reason: `task graph contains invalid JSON: ${source}` };
  }

  const result = kitTaskGraphSchema.safeParse(data);
  if (!result.success) {
    return { status: "invalid", source, reason: `task graph has an invalid shape: ${source}` };
  }
  const validation = validateTaskGraph(result.data);
  if (!validation.ok) {
    return { status: "invalid", source, reason: validation.reason };
  }
  return { status: "loaded", graph: result.data, source };
}

/**
 * Initial graph discovery. An explicit feature name is exact: missing or
 * invalid named graphs never fall through to another feature or plan source.
 * Unnamed discovery retains the existing latest-feature behavior.
 */
export async function loadTaskGraphDetailed(
  projectPath: string,
  featureDirName?: string
): Promise<{ graph: KitTaskGraph | null; source: string | null; warnings: string[] }> {
  const kitGraph = await loadVispKitTaskGraph(projectPath, featureDirName);
  if (kitGraph.status === "loaded") {
    return { graph: kitGraph.graph, source: kitGraph.source, warnings: [] };
  }
  if (kitGraph.status !== "absent") {
    return { graph: null, source: kitGraph.source, warnings: [kitGraph.reason] };
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
 * original graph order is preserved (stable). Invalid graphs return no
 * ordering; on a cycle, `cycle` lists the task ids that remain unresolved.
 */
export function orderTasks(
  graph: KitTaskGraph
): { ordered: KitTask[]; cycle: string[] | null; errors: string[] } {
  const validation = validateTaskGraph(graph);
  if (!validation.ok) {
    return { ordered: [], cycle: validation.cycle, errors: validation.errors };
  }
  return { ordered: validation.ordered, cycle: null, errors: [] };
}

/**
 * Build the starting pipeline state from a task graph. Tasks already marked
 * `verified`/`done` are recorded as completed; `currentTaskId` is the first
 * ordered task not yet completed (or `null` when all are complete). Invalid
 * graphs are rejected rather than represented as an apparently complete state.
 */
export function initialPipelineState(
  graph: KitTaskGraph,
  graphIdentity: PipelineGraphIdentity
): PipelineState {
  const validation = validateTaskGraph(graph);
  if (!validation.ok) {
    throw new Error(`Cannot initialize pipeline: ${validation.reason}`);
  }
  const identityError = graphIdentityError(graph, graphIdentity);
  if (identityError) {
    throw new Error(`Cannot initialize pipeline: ${identityError}`);
  }

  const completed: string[] = [];
  let currentTaskId: string | null = null;
  for (const task of validation.ordered) {
    if (task.status && COMPLETED_STATUSES.has(task.status)) {
      completed.push(task.id);
    } else if (currentTaskId === null) {
      currentTaskId = task.id;
    }
  }

  const completedSet = new Set(completed);
  const invalidCompletedTask = validation.ordered.find(
    (task) => completedSet.has(task.id) && task.dependsOn.some((dependency) => !completedSet.has(dependency))
  );
  if (invalidCompletedTask) {
    throw new Error(
      `Cannot initialize pipeline: completed task ${invalidCompletedTask.id} has an unfinished dependency`
    );
  }

  return {
    taskIds: validation.ordered.map((task) => task.id),
    currentTaskId,
    completed,
    stepHistory: [],
    graphIdentity: { ...graphIdentity },
    taskKeys: taskKeysForGraph(graph, graphIdentity),
    graphFingerprint: graphFingerprintFor(graph),
    injectedTaskFingerprints: {}
  };
}

function baseGraphForState(graph: KitTaskGraph, state: PipelineState): KitTaskGraph {
  const injectedIds = new Set((state.injectedTasks ?? []).map((task) => task.id));
  if (injectedIds.size === 0) {
    return graph;
  }
  return {
    ...graph,
    tasks: graph.tasks
      .filter((task) => !injectedIds.has(task.id))
      .map((task) => ({
        ...task,
        dependsOn: task.dependsOn.filter((dependency) => !injectedIds.has(dependency))
      }))
  };
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const entries = (value: Record<string, string>) =>
    Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

function isExactDependencyOrder(graph: KitTaskGraph, orderedIds: readonly string[]): boolean {
  if (orderedIds.length !== graph.tasks.length) {
    return false;
  }
  const positions = new Map<string, number>();
  for (const [index, taskId] of orderedIds.entries()) {
    if (positions.has(taskId)) {
      return false;
    }
    positions.set(taskId, index);
  }
  if (graph.tasks.some((task) => !positions.has(task.id))) {
    return false;
  }
  return graph.tasks.every((task) => {
    const taskPosition = positions.get(task.id)!;
    return task.dependsOn.every((dependency) => {
      const dependencyPosition = positions.get(dependency);
      return dependencyPosition !== undefined && dependencyPosition < taskPosition;
    });
  });
}

/** True only for a non-empty pipeline whose effective task set is exhausted. */
export function isPipelineComplete(state: PipelineState): boolean {
  if (state.currentTaskId !== null || state.taskIds.length === 0) {
    return false;
  }
  const taskIds = new Set(state.taskIds);
  const completed = new Set(state.completed);
  if (taskIds.size !== state.taskIds.length || completed.size !== state.completed.length) {
    return false;
  }
  return completed.size === taskIds.size && [...completed].every((taskId) => taskIds.has(taskId));
}

/**
 * Bind persisted pipeline state to an already resolved effective graph. Legacy
 * identity is readable but non-authorizing, and stale task sets fail closed.
 */
export function validatePipelineState(
  graph: KitTaskGraph,
  state: PipelineState,
  options: { sessionId?: string } = {}
): PipelineStateValidationResult {
  if (!state.graphIdentity || !state.taskKeys || !state.graphFingerprint) {
    return {
      ok: false,
      reasonCode: "pipeline_identity_missing",
      reason: "The pipeline predates exact graph identity; start a fresh session instead of guessing."
    };
  }
  if (
    state.graphIdentity.kind === "synthetic" &&
    (!options.sessionId || state.graphIdentity.source !== `quick:${options.sessionId}`)
  ) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: "The synthetic graph identity does not belong to the active session."
    };
  }

  const graphValidation = validateTaskGraph(graph);
  if (!graphValidation.ok) {
    return { ok: false, reasonCode: "pipeline_graph_mismatch", reason: graphValidation.reason };
  }
  const baseGraph = baseGraphForState(graph, state);
  const baseValidation = validateTaskGraph(baseGraph);
  if (!baseValidation.ok) {
    return { ok: false, reasonCode: "pipeline_graph_mismatch", reason: baseValidation.reason };
  }
  const identityError = graphIdentityError(baseGraph, state.graphIdentity);
  if (identityError) {
    return { ok: false, reasonCode: "pipeline_graph_mismatch", reason: identityError };
  }

  const expectedKeys = taskKeysForGraph(baseGraph, state.graphIdentity);
  if (!sameStringRecord(expectedKeys, state.taskKeys)) {
    return {
      ok: false,
      reasonCode: "pipeline_graph_mismatch",
      reason: "The loaded graph task keys do not match the pinned pipeline task keys."
    };
  }
  if (graphFingerprintFor(baseGraph) !== state.graphFingerprint) {
    return {
      ok: false,
      reasonCode: "pipeline_graph_mismatch",
      reason: "The loaded task graph changed after this pipeline was created."
    };
  }

  const expectedInjectedFingerprints = injectedTaskFingerprintsFor(state.injectedTasks ?? []);
  if (!sameStringRecord(expectedInjectedFingerprints, state.injectedTaskFingerprints ?? {})) {
    return {
      ok: false,
      reasonCode: "pipeline_graph_mismatch",
      reason: "A persisted remediation task changed after it was injected."
    };
  }

  const taskIds = new Set<string>();
  for (const taskId of state.taskIds) {
    if (!taskId.trim() || taskId !== taskId.trim() || taskIds.has(taskId)) {
      return {
        ok: false,
        reasonCode: "pipeline_state_invalid",
        reason: "Pipeline taskIds must be non-empty, trimmed, and unique."
      };
    }
    taskIds.add(taskId);
  }
  const graphIds = new Set(graph.tasks.map((task) => task.id));
  if (taskIds.size !== graphIds.size || [...taskIds].some((taskId) => !graphIds.has(taskId))) {
    return {
      ok: false,
      reasonCode: "pipeline_graph_mismatch",
      reason: "The pipeline task set does not match the resolved graph."
    };
  }
  const injectedIds = new Set((state.injectedTasks ?? []).map((task) => task.id));
  const persistedBaseOrder = state.taskIds.filter((taskId) => !injectedIds.has(taskId));
  const expectedBaseOrder = baseValidation.ordered.map((task) => task.id);
  if (JSON.stringify(persistedBaseOrder) !== JSON.stringify(expectedBaseOrder)) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: "Pipeline base tasks are not in the pinned graph's stable dependency order."
    };
  }
  if (!isExactDependencyOrder(graph, state.taskIds)) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: "Pipeline taskIds are not a valid dependency order for the resolved graph."
    };
  }

  const completed = new Set<string>();
  for (const taskId of state.completed) {
    if (!taskIds.has(taskId) || completed.has(taskId)) {
      return {
        ok: false,
        reasonCode: "pipeline_state_invalid",
        reason: "Pipeline completed tasks must be unique members of the pinned task set."
      };
    }
    completed.add(taskId);
  }

  const checkpointPassed = new Set(
    state.stepHistory
      .filter((step) => step.action === "checkpoint-passed")
      .map((step) => step.taskId)
  );
  if ([...checkpointPassed].some((taskId) => !completed.has(taskId))) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: "A checkpoint-passed task is missing from the completed task set."
    };
  }
  for (const taskId of completed) {
    const task = graph.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      return {
        ok: false,
        reasonCode: "pipeline_state_invalid",
        reason: `Completed task ${taskId} is missing from the resolved graph.`
      };
    }
    if (task.dependsOn.some((dependency) => !completed.has(dependency))) {
      return {
        ok: false,
        reasonCode: "pipeline_state_invalid",
        reason: `Completed task ${taskId} has an unfinished dependency.`
      };
    }
    if (!COMPLETED_STATUSES.has(task.status ?? "") && !checkpointPassed.has(taskId)) {
      return {
        ok: false,
        reasonCode: "pipeline_state_invalid",
        reason: `Completed task ${taskId} has no completed graph status or passing checkpoint evidence.`
      };
    }
  }

  if (state.currentTaskId === null) {
    return isPipelineComplete(state)
      ? { ok: true }
      : {
          ok: false,
          reasonCode: "pipeline_state_invalid",
          reason: "The pipeline has unfinished tasks but no current task."
        };
  }
  if (!taskIds.has(state.currentTaskId) || completed.has(state.currentTaskId)) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: "The current task is missing from the graph or is already completed."
    };
  }
  const firstIncomplete = state.taskIds.find((taskId) => !completed.has(taskId));
  if (firstIncomplete !== state.currentTaskId) {
    return {
      ok: false,
      reasonCode: "pipeline_state_invalid",
      reason: `The current task does not match the first unfinished task (${firstIncomplete ?? "none"}).`
    };
  }
  return { ok: true };
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

  const graphValidation = validateTaskGraph(graph);
  if (!graphValidation.ok) {
    return {
      ...state,
      completed: [...state.completed],
      stepHistory: [
        ...state.stepHistory,
        {
          taskId: state.currentTaskId,
          action: "checkpoint-failed",
          at: now,
          detail: graphValidation.reason
        }
      ]
    };
  }

  const passed = evidence.verifyPassed && evidence.reviewPassed;
  const current = state.currentTaskId;

  if (!isExactDependencyOrder(graph, state.taskIds)) {
    return {
      ...state,
      completed: [...state.completed],
      stepHistory: [
        ...state.stepHistory,
        {
          taskId: current,
          action: "checkpoint-failed",
          at: now,
          detail: "pipeline task order is stale or violates graph dependencies"
        }
      ]
    };
  }

  if (!graphValidation.ordered.some((task) => task.id === current) || state.completed.includes(current)) {
    return {
      ...state,
      completed: [...state.completed],
      stepHistory: [
        ...state.stepHistory,
        {
          taskId: current,
          action: "checkpoint-failed",
          at: now,
          detail: "current task is stale or already completed"
        }
      ]
    };
  }

  if (!passed) {
    return {
      ...state,
      completed: [...state.completed],
      stepHistory: [
        ...state.stepHistory,
        { taskId: current, action: "checkpoint-failed", at: now, detail: evidence.detail }
      ]
    };
  }

  const completed = [...state.completed, current];
  const nextTaskId = state.taskIds.find((id) => !completed.includes(id)) ?? null;

  return {
    ...state,
    currentTaskId: nextTaskId,
    completed,
    stepHistory: [
      ...state.stepHistory,
      { taskId: current, action: "checkpoint-passed", at: now, detail: evidence.detail }
    ]
  };
}

/**
 * Compute the ready-set of parallelizable sibling task ids for a given current
 * task. A sibling is "ready" when every one of its `dependsOn` ids is already in
 * `completed`, it is itself `parallelizable === true`, it is not
 * the current task, and it is not already completed. Ids are returned in stable
 * graph order. Pure: reads only the passed graph/state, changes nothing.
 */
export function readySet(
  graph: KitTaskGraph,
  currentTaskId: string,
  completed: readonly string[]
): string[] {
  if (!validateTaskGraph(graph).ok) {
    return [];
  }
  const done = new Set(completed);

  return graph.tasks
    .filter((task) => {
      if (task.id === currentTaskId || done.has(task.id)) {
        return false;
      }
      if (task.parallelizable !== true) {
        return false;
      }
      return task.dependsOn.every((dep) => done.has(dep));
    })
    .map((task) => task.id);
}

/**
 * Render the bounded, deterministic task-action text block. Sections with no
 * data are omitted. Style mirrors the handoff protocol renderer.
 *
 * When the current task is `parallelizable === true` and `concurrentWith` names a
 * non-empty ready-set of sibling ids (see {@link readySet}), a single
 * deterministic `may_run_concurrently_with: <ids>` line is appended after the
 * risk line. The line is omitted entirely when the task is not parallelizable or
 * the ready-set is empty, so existing non-parallelizable output stays
 * byte-identical.
 */
export function buildActionBlock(
  task: KitTask,
  options: { contextPackPath?: string; sessionId?: string; concurrentWith?: readonly string[]; knownFailureModes?: string[] } = {}
): string {
  const lines: string[] = ["BEGIN_VISP_TASK_ACTION"];

  lines.push(`task: ${task.id}${task.title ? ` - ${task.title}` : ""}`);
  lines.push(
    `risk: ${task.riskLevel ?? "unknown"}    parallelizable: ${task.parallelizable === true ? "true" : "false"}`
  );
  if (task.parallelizable === true && options.concurrentWith && options.concurrentWith.length > 0) {
    lines.push(`may_run_concurrently_with: ${options.concurrentWith.join(", ")}`);
  }
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

  if (options.knownFailureModes && options.knownFailureModes.length > 0) {
    lines.push("");
    lines.push("known_failure_modes:");
    for (const mode of options.knownFailureModes) lines.push(`  - ${mode}`);
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
