import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitTaskGraphSchema, type KitTask, type KitTaskGraph } from "../../../src/kit/kit-schemas.js";
import {
  advance,
  buildActionBlock,
  currentTask,
  initialPipelineState,
  loadTaskGraph,
  orderTasks,
  readySet
} from "../../../src/pipeline/pipeline-engine.js";
import { readState, writeState } from "../../../src/core/session-manager.js";
import type { HyperState, SessionRecord } from "../../../src/core/types.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vh-pipeline-"));
}

async function writeFeature(projectPath: string, dirName: string, graph: unknown): Promise<void> {
  const dir = join(projectPath, ".visp", "features", dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "task-graph.json"), JSON.stringify(graph, null, 2), "utf8");
}

function graphFromTasks(tasks: Array<Partial<KitTask> & { id: string }>): KitTaskGraph {
  return kitTaskGraphSchema.parse({ featureId: "999", tasks });
}

// Real-shaped fixture mirroring this repo's feature 004 task graph.
const realShapedGraph = {
  featureId: "004",
  featureSlug: "pipeline-engine-run-command",
  tasks: [
    {
      id: "T001",
      title: "ValidationCommandRunner and BranchSessionLocator",
      description: "Implement runners and locators with unit tests.",
      requirementIds: ["REQ001", "REQ002"],
      acceptanceCriterionIds: ["AC001", "AC002", "AC003"],
      dependsOn: [],
      allowedFiles: ["src/quality/validation-runner.ts"],
      expectedFiles: ["src/quality/validation-runner.ts"],
      forbiddenFiles: ["Dependency manifests"],
      validationCommands: ["pnpm typecheck"],
      status: "verified",
      parallelizable: true,
      riskLevel: "low"
    },
    {
      id: "T002",
      title: "Pipeline Engine and Session State",
      description: "Build the pure pipeline engine and session state extension.",
      requirementIds: ["REQ004"],
      acceptanceCriterionIds: ["AC009"],
      dependsOn: ["T001"],
      allowedFiles: ["src/pipeline/pipeline-engine.ts"],
      expectedFiles: ["src/pipeline/pipeline-engine.ts"],
      forbiddenFiles: ["Dependency manifests"],
      validationCommands: ["pnpm exec vitest run tests/pipeline-engine.test.ts", "pnpm typecheck"],
      status: "pending",
      parallelizable: false,
      riskLevel: "medium"
    }
  ],
  createdAt: "2026-06-11T08:33:30.722Z",
  updatedAt: "2026-06-11T08:33:30.722Z"
};

describe("loadTaskGraph", () => {
  it("parses a real-shaped task graph from a feature directory", async () => {
    const project = await tempProject();
    await writeFeature(project, "004-pipeline-engine", realShapedGraph);

    const graph = await loadTaskGraph(project);
    expect(graph).not.toBeNull();
    expect(graph?.featureId).toBe("004");
    expect(graph?.tasks).toHaveLength(2);
    expect(graph?.tasks[0]?.id).toBe("T001");
    expect(graph?.tasks[0]?.dependsOn).toEqual([]);
    expect(graph?.tasks[1]?.dependsOn).toEqual(["T001"]);
  });

  it("returns null when the features directory is absent", async () => {
    const project = await tempProject();
    const graph = await loadTaskGraph(project);
    expect(graph).toBeNull();
  });

  it("returns null (no throw) for invalid JSON", async () => {
    const project = await tempProject();
    const dir = join(project, ".visp", "features", "004-broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "task-graph.json"), "{ not valid json", "utf8");

    await expect(loadTaskGraph(project)).resolves.toBeNull();
  });

  it("returns null (no throw) for valid JSON that fails the schema", async () => {
    const project = await tempProject();
    await writeFeature(project, "004-bad-shape", { featureId: "004", tasks: "nope" });

    await expect(loadTaskGraph(project)).resolves.toBeNull();
  });

  it("prefers the named feature directory when multiple exist", async () => {
    const project = await tempProject();
    await writeFeature(project, "003-old", graphFromTasks([{ id: "OLD" }]));
    await writeFeature(project, "004-new", graphFromTasks([{ id: "NEW" }]));

    const named = await loadTaskGraph(project, "003-old");
    expect(named?.tasks[0]?.id).toBe("OLD");
  });

  it("falls back to the highest sorted feature directory when unnamed", async () => {
    const project = await tempProject();
    await writeFeature(project, "003-old", graphFromTasks([{ id: "OLD" }]));
    await writeFeature(project, "004-new", graphFromTasks([{ id: "NEW" }]));

    const latest = await loadTaskGraph(project);
    expect(latest?.tasks[0]?.id).toBe("NEW");
  });
});

describe("orderTasks", () => {
  it("orders a linear chain", () => {
    const graph = graphFromTasks([
      { id: "C", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
      { id: "A", dependsOn: [] }
    ]);
    const { ordered, cycle } = orderTasks(graph);
    expect(cycle).toBeNull();
    expect(ordered.map((task) => task.id)).toEqual(["A", "B", "C"]);
  });

  it("orders a diamond with stable graph order among ready tasks", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] }
    ]);
    const { ordered, cycle } = orderTasks(graph);
    expect(cycle).toBeNull();
    expect(ordered.map((task) => task.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("detects a cycle and returns the involved ids", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] }
    ]);
    const { ordered, cycle } = orderTasks(graph);
    expect(ordered).toEqual([]);
    expect(cycle).toEqual(["A", "B"]);
  });

  it("treats unknown dependency ids as satisfied", () => {
    const graph = graphFromTasks([{ id: "A", dependsOn: ["GHOST"] }]);
    const { ordered, cycle } = orderTasks(graph);
    expect(cycle).toBeNull();
    expect(ordered.map((task) => task.id)).toEqual(["A"]);
  });
});

describe("initialPipelineState", () => {
  it("makes the first task current for a fresh graph", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] }
    ]);
    const state = initialPipelineState(graph);
    expect(state.taskIds).toEqual(["A", "B"]);
    expect(state.currentTaskId).toBe("A");
    expect(state.completed).toEqual([]);
    expect(state.stepHistory).toEqual([]);
  });

  it("skips completed tasks and makes the next one current", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], status: "verified" },
      { id: "B", dependsOn: ["A"] }
    ]);
    const state = initialPipelineState(graph);
    expect(state.completed).toEqual(["A"]);
    expect(state.currentTaskId).toBe("B");
  });

  it("returns a null current task when all are complete", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], status: "done" },
      { id: "B", dependsOn: ["A"], status: "verified" }
    ]);
    const state = initialPipelineState(graph);
    expect(state.completed).toEqual(["A", "B"]);
    expect(state.currentTaskId).toBeNull();
  });
});

describe("currentTask", () => {
  it("resolves the current task object", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] }
    ]);
    const state = initialPipelineState(graph);
    expect(currentTask(graph, state)?.id).toBe("A");
  });

  it("returns null when there is no current task", () => {
    const graph = graphFromTasks([{ id: "A", dependsOn: [], status: "done" }]);
    const state = initialPipelineState(graph);
    expect(currentTask(graph, state)).toBeNull();
  });
});

describe("advance", () => {
  const graph = graphFromTasks([
    { id: "A", dependsOn: [] },
    { id: "B", dependsOn: ["A"] }
  ]);

  it("completes the current task and moves on when both gates pass", () => {
    const initial = initialPipelineState(graph);
    const next = advance(initial, graph, { verifyPassed: true, reviewPassed: true, detail: "ok" }, "T1");

    expect(next.completed).toEqual(["A"]);
    expect(next.currentTaskId).toBe("B");
    expect(next.stepHistory).toHaveLength(1);
    expect(next.stepHistory[0]).toEqual({ taskId: "A", action: "checkpoint-passed", at: "T1", detail: "ok" });
    // Original state is untouched (pure).
    expect(initial.completed).toEqual([]);
    expect(initial.currentTaskId).toBe("A");
  });

  it("stays on the current task and records a failure when a gate fails", () => {
    const initial = initialPipelineState(graph);
    const next = advance(initial, graph, { verifyPassed: true, reviewPassed: false, detail: "review failed" }, "T2");

    expect(next.completed).toEqual([]);
    expect(next.currentTaskId).toBe("A");
    expect(next.stepHistory[0]).toEqual({
      taskId: "A",
      action: "checkpoint-failed",
      at: "T2",
      detail: "review failed"
    });
  });

  it("sets currentTaskId to null when the pipeline is exhausted", () => {
    let state = initialPipelineState(graph);
    state = advance(state, graph, { verifyPassed: true, reviewPassed: true }, "T1");
    state = advance(state, graph, { verifyPassed: true, reviewPassed: true }, "T2");

    expect(state.completed).toEqual(["A", "B"]);
    expect(state.currentTaskId).toBeNull();
  });

  it("returns the state unchanged when there is no current task", () => {
    const graph = graphFromTasks([{ id: "A", dependsOn: [], status: "done" }]);
    const state = initialPipelineState(graph);
    const next = advance(state, graph, { verifyPassed: true, reviewPassed: true }, "T1");
    expect(next).toBe(state);
  });

  it("fails closed when the re-computed graph reports a dependency cycle", () => {
    // State is built from an acyclic graph (A -> B), so currentTaskId is A.
    const state = initialPipelineState(graph);
    expect(state.currentTaskId).toBe("A");

    // The graph is re-edited between handoff and checkpoint into a cycle
    // (A depends on B, B depends on A). advance() must NOT trust the stale
    // taskIds order or advance the pipeline.
    const cyclicGraph = graphFromTasks([
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] }
    ]);

    const next = advance(state, cyclicGraph, { verifyPassed: true, reviewPassed: true }, "T9");

    // Not completed, not advanced.
    expect(next.completed).toEqual([]);
    expect(next.currentTaskId).toBe("A");
    const last = next.stepHistory[next.stepHistory.length - 1];
    expect(last?.action).toBe("checkpoint-failed");
    expect(last?.detail).toContain("dependency cycle");
    expect(last?.detail).toContain("A");
    expect(last?.detail).toContain("B");
  });
});

describe("readySet", () => {
  it("returns parallelizable siblings whose deps are all completed, in graph order", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: [], parallelizable: true },
      { id: "C", dependsOn: [], parallelizable: true }
    ]);
    // Current task is A; B and C are ready parallelizable siblings.
    expect(readySet(graph, "A", [])).toEqual(["B", "C"]);
  });

  it("excludes the current task and already-completed tasks", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: [], parallelizable: true },
      { id: "C", dependsOn: [], parallelizable: true }
    ]);
    // B is completed, A is current -> only C remains.
    expect(readySet(graph, "A", ["B"])).toEqual(["C"]);
  });

  it("excludes non-parallelizable siblings", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: [], parallelizable: false },
      { id: "C", dependsOn: [] } // parallelizable undefined -> excluded
    ]);
    expect(readySet(graph, "A", [])).toEqual([]);
  });

  it("excludes siblings whose dependencies are not yet completed", () => {
    // X is a real task in the graph, so its completion actually gates B and C.
    const graph = graphFromTasks([
      { id: "X", dependsOn: [], parallelizable: true },
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: ["X"], parallelizable: true },
      { id: "C", dependsOn: ["X"], parallelizable: true }
    ]);
    // With X not completed, B and C are not ready; only X qualifies as a sibling.
    expect(readySet(graph, "A", [])).toEqual(["X"]);
    // Once X is completed, B and C become ready (and X drops out as completed).
    expect(readySet(graph, "A", ["X"])).toEqual(["B", "C"]);
  });

  it("treats unknown dependency ids as satisfied (mirrors orderTasks)", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: ["GHOST"], parallelizable: true }
    ]);
    // GHOST is not a task in the graph, so it is treated as satisfied.
    expect(readySet(graph, "A", [])).toEqual(["B"]);
  });

  it("returns an empty array when there are no parallelizable siblings", () => {
    const graph = graphFromTasks([
      { id: "A", dependsOn: [], parallelizable: true },
      { id: "B", dependsOn: ["A"], parallelizable: false }
    ]);
    expect(readySet(graph, "A", [])).toEqual([]);
  });
});

describe("buildActionBlock", () => {
  const fullTask: KitTask = kitTaskGraphSchema.parse({
    tasks: [
      {
        id: "T002",
        title: "Pipeline Engine",
        description: "Build the pure pipeline engine.",
        dependsOn: [],
        allowedFiles: ["src/pipeline/pipeline-engine.ts"],
        forbiddenFiles: ["package.json"],
        acceptanceCriterionIds: ["AC009"],
        validationCommands: ["pnpm typecheck"],
        parallelizable: false,
        riskLevel: "medium"
      }
    ]
  }).tasks[0]!;

  it("renders all sections for a full task", () => {
    const block = buildActionBlock(fullTask, {
      contextPackPath: ".visp/hyper/current/context-pack.md",
      sessionId: "vh_x"
    });

    expect(block).toContain("BEGIN_VISP_TASK_ACTION");
    expect(block).toContain("task: T002 - Pipeline Engine");
    expect(block).toContain("risk: medium    parallelizable: false");
    expect(block).toContain("session: vh_x");
    expect(block).toContain("Build the pure pipeline engine.");
    expect(block).toContain("allowed_files:");
    expect(block).toContain("  - src/pipeline/pipeline-engine.ts");
    expect(block).toContain("forbidden_files:");
    expect(block).toContain("  - package.json");
    expect(block).toContain("acceptance_criteria:");
    expect(block).toContain("  - AC009");
    expect(block).toContain("validation_commands:");
    expect(block).toContain("  - pnpm typecheck");
    expect(block).toContain("context_pack: .visp/hyper/current/context-pack.md");
    expect(block).toContain("END_VISP_TASK_ACTION");
  });

  it("omits absent sections and falls back to title/unknown", () => {
    const sparse = graphFromTasks([{ id: "T010", title: "Sparse" }]).tasks[0]!;
    const block = buildActionBlock(sparse);

    expect(block).not.toContain("allowed_files:");
    expect(block).not.toContain("forbidden_files:");
    expect(block).not.toContain("acceptance_criteria:");
    expect(block).not.toContain("validation_commands:");
    expect(block).not.toContain("context_pack:");
    expect(block).not.toContain("session:");
    expect(block).toContain("risk: unknown    parallelizable: false");
    // goal falls back to title when description is absent.
    expect(block).toContain("  Sparse");
  });

  it("mentions the checkpoint command with the task id in done_criteria", () => {
    const block = buildActionBlock(fullTask);
    expect(block).toContain("done_criteria:");
    expect(block).toContain("`visp save --task T002 --input-tokens <N> --output-tokens <M>`");
    expect(block).toContain("records this task as cost-unavailable");
  });

  const parallelTask: KitTask = graphFromTasks([
    { id: "T100", title: "Parallel", parallelizable: true, riskLevel: "low" }
  ]).tasks[0]!;

  it("appends may_run_concurrently_with when parallelizable and the ready-set is non-empty", () => {
    const block = buildActionBlock(parallelTask, { concurrentWith: ["T101", "T102"] });
    expect(block).toContain("parallelizable: true");
    expect(block).toContain("may_run_concurrently_with: T101, T102");
    // The line sits directly after the risk line.
    const lines = block.split("\n");
    const riskIndex = lines.findIndex((line) => line.startsWith("risk:"));
    expect(lines[riskIndex + 1]).toBe("may_run_concurrently_with: T101, T102");
  });

  it("omits may_run_concurrently_with when the ready-set is empty", () => {
    const block = buildActionBlock(parallelTask, { concurrentWith: [] });
    expect(block).not.toContain("may_run_concurrently_with:");
  });

  it("omits may_run_concurrently_with when concurrentWith is not provided", () => {
    const block = buildActionBlock(parallelTask);
    expect(block).not.toContain("may_run_concurrently_with:");
  });

  it("omits may_run_concurrently_with when the task is not parallelizable even if siblings are passed", () => {
    // fullTask has parallelizable: false — the line must never render for it, so
    // pinned non-parallelizable output stays byte-identical.
    const block = buildActionBlock(fullTask, { concurrentWith: ["T101"] });
    expect(block).toContain("parallelizable: false");
    expect(block).not.toContain("may_run_concurrently_with:");
  });
});

describe("session state round-trip (AC009)", () => {
  it("writes and reads back a session that carries pipeline state", async () => {
    const project = await tempProject();
    const session: SessionRecord = {
      id: "vh_20260611_abc12345",
      goal: "Build pipeline",
      tool: "codex",
      projectPath: project,
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:00.000Z",
      phase: "implementation",
      relevantFiles: ["src/pipeline/pipeline-engine.ts"],
      pipeline: {
        taskIds: ["T001", "T002"],
        currentTaskId: "T002",
        completed: ["T001"],
        stepHistory: [{ taskId: "T001", action: "checkpoint-passed", at: "2026-06-11T00:00:00.000Z", detail: "ok" }]
      }
    };
    const state: HyperState = { activeSessionId: session.id, sessions: { [session.id]: session } };

    await writeState(project, state);
    const roundTripped = await readState(project);

    const read = roundTripped.sessions[session.id];
    expect(read?.pipeline?.currentTaskId).toBe("T002");
    expect(read?.pipeline?.completed).toEqual(["T001"]);
    expect(read?.pipeline?.stepHistory[0]?.action).toBe("checkpoint-passed");
  });

  it("parses a legacy session object that lacks the pipeline field", async () => {
    const project = await tempProject();
    const legacy = {
      activeSessionId: "vh_legacy",
      sessions: {
        vh_legacy: {
          id: "vh_legacy",
          goal: "Legacy goal",
          tool: "generic",
          projectPath: project,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          phase: "implementation",
          relevantFiles: []
        }
      }
    };
    const statePath = join(project, ".visp", "hyper", "state.json");
    await mkdir(join(project, ".visp", "hyper"), { recursive: true });
    await writeFile(statePath, JSON.stringify(legacy, null, 2), "utf8");

    const read = await readState(project);
    expect(read.sessions.vh_legacy?.goal).toBe("Legacy goal");
    expect(read.sessions.vh_legacy?.pipeline).toBeUndefined();
  });
});
