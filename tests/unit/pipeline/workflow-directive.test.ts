import { describe, expect, it } from "vitest";
import { computeExecutionTiers, renderWorkflowDirective } from "../../../src/pipeline/workflow-directive.js";
import type { KitTask } from "../../../src/kit/kit-schemas.js";
import type { PipelineState } from "../../../src/core/types.js";

function task(id: string, overrides: Partial<KitTask> = {}): KitTask {
  return { id, title: `Task ${id}`, dependsOn: [], ...overrides };
}

function stateFor(tasks: KitTask[], completed: string[] = []): PipelineState {
  return {
    taskIds: tasks.map((entry) => entry.id),
    currentTaskId: tasks.find((entry) => !completed.includes(entry.id))?.id ?? null,
    completed,
    stepHistory: []
  };
}

const PARALLEL_GRAPH = {
  tasks: [
    task("T001", { parallelizable: true, allowedFiles: ["src/a"] }),
    task("T002", { parallelizable: true, allowedFiles: ["src/b"] }),
    task("T003", { dependsOn: ["T001", "T002"], allowedFiles: ["src"] })
  ]
};

describe("computeExecutionTiers", () => {
  it("layers by dependencies and qualifies disjoint parallelizable tasks", () => {
    const tiers = computeExecutionTiers(PARALLEL_GRAPH, stateFor(PARALLEL_GRAPH.tasks));
    expect(tiers[0]!.parallel.map((entry) => entry.id)).toEqual(["T001", "T002"]);
    expect(tiers[0]!.sequential).toEqual([]);
    expect(tiers[1]!.parallel).toEqual([]);
    expect(tiers[1]!.sequential.map((entry) => entry.id)).toEqual(["T003"]);
  });

  it("overlapping file scopes disqualify the parallel set", () => {
    const graph = {
      tasks: [
        task("T001", { parallelizable: true, allowedFiles: ["src/a"] }),
        task("T002", { parallelizable: true, allowedFiles: ["src/a/deep"] })
      ]
    };
    const tiers = computeExecutionTiers(graph, stateFor(graph.tasks));
    expect(tiers[0]!.parallel).toEqual([]);
    expect(tiers[0]!.sequential.map((entry) => entry.id)).toEqual(["T001", "T002"]);
  });

  it("missing allowedFiles means unbounded scope and never parallelizes", () => {
    const graph = {
      tasks: [
        task("T001", { parallelizable: true }),
        task("T002", { parallelizable: true, allowedFiles: ["src/b"] })
      ]
    };
    const tiers = computeExecutionTiers(graph, stateFor(graph.tasks));
    expect(tiers[0]!.parallel).toEqual([]);
  });

  it("completed tasks are excluded from the layering", () => {
    const tiers = computeExecutionTiers(PARALLEL_GRAPH, stateFor(PARALLEL_GRAPH.tasks, ["T001", "T002"]));
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.sequential.map((entry) => entry.id)).toEqual(["T003"]);
  });

  it("a cycle among remaining tasks degrades to one sequential tier", () => {
    const graph = {
      tasks: [
        task("T001", { dependsOn: ["T002"], parallelizable: true, allowedFiles: ["src/a"] }),
        task("T002", { dependsOn: ["T001"], parallelizable: true, allowedFiles: ["src/b"] })
      ]
    };
    const tiers = computeExecutionTiers(graph, stateFor(graph.tasks));
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.parallel).toEqual([]);
    expect(tiers[0]!.sequential.map((entry) => entry.id)).toEqual(["T001", "T002"]);
  });
});

describe("renderWorkflowDirective", () => {
  it("renders tiers, checkpoint order, and the claude-code fan-out hint", () => {
    const tiers = computeExecutionTiers(PARALLEL_GRAPH, stateFor(PARALLEL_GRAPH.tasks));
    const block = renderWorkflowDirective({ tiers, tool: "claude-code", sessionId: "vh_x" });
    expect(block).toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    expect(block).toContain("session: vh_x");
    expect(block).toContain("1. parallel: T001, T002 (disjoint file scopes, parallelizable)");
    expect(block).toContain("2. sequential: T003");
    expect(block).toContain("in this order only: T001, T002, T003.");
    expect(block).toContain("subagent via the Task tool");
    expect(block).toContain("END_VISP_WORKFLOW_DIRECTIVE");
  });

  it("other tools get the sequential interpretation hint", () => {
    const tiers = computeExecutionTiers(PARALLEL_GRAPH, stateFor(PARALLEL_GRAPH.tasks));
    const block = renderWorkflowDirective({ tiers, tool: "codex", sessionId: "vh_x" });
    expect(block).toContain("safe-to-reorder, not as a concurrency requirement");
    expect(block).not.toContain("Task tool");
  });

  it("returns null for sequential graphs and single-task pipelines", () => {
    const sequential = { tasks: [task("T001"), task("T002", { dependsOn: ["T001"] })] };
    expect(
      renderWorkflowDirective({
        tiers: computeExecutionTiers(sequential, stateFor(sequential.tasks)),
        tool: "claude-code",
        sessionId: "vh_x"
      })
    ).toBeNull();

    const single = { tasks: [task("Q001", { parallelizable: true, allowedFiles: ["src"] })] };
    expect(
      renderWorkflowDirective({
        tiers: computeExecutionTiers(single, stateFor(single.tasks)),
        tool: "claude-code",
        sessionId: "vh_x"
      })
    ).toBeNull();
  });

  it("is deterministic", () => {
    const tiers = computeExecutionTiers(PARALLEL_GRAPH, stateFor(PARALLEL_GRAPH.tasks));
    const render = () => renderWorkflowDirective({ tiers, tool: "claude-code", sessionId: "vh_x" });
    expect(render()).toBe(render());
  });
});
