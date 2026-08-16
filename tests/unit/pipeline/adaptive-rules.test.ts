import { describe, expect, it } from "vitest";
import {
  applyAdaptiveDecision,
  consecutiveFailures,
  decideAdaptiveAction,
  effectiveGraph,
  evidenceRequirements,
  renderAdaptationBlock,
  synthesizeRemediationTask,
  ESCALATION_AFTER_FAILURES,
  REMEDIATION_AFTER_FAILURES
} from "../../../src/pipeline/adaptive-rules.js";
import { advance, currentTask, orderTasks } from "../../../src/pipeline/pipeline-engine.js";
import type { FailurePattern } from "../../../src/memory/failure-patterns.js";
import type { PipelineState } from "../../../src/core/types.js";
import type { KitTask } from "../../../src/kit/kit-schemas.js";

const NOW = "2026-07-03T00:00:00.000Z";

function task(id: string, overrides: Partial<KitTask> = {}): KitTask {
  return { id, title: `Task ${id}`, dependsOn: [], ...overrides };
}

function stateWith(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    taskIds: ["T001", "T002"],
    currentTaskId: "T001",
    completed: [],
    stepHistory: [],
    ...overrides
  };
}

function failures(taskId: string, count: number): PipelineState["stepHistory"] {
  return Array.from({ length: count }, (_, index) => ({
    taskId,
    action: "checkpoint-failed" as const,
    at: NOW,
    detail: `attempt ${index + 1}`
  }));
}

function pattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    id: "fp_1",
    signature: "sig",
    taskId: "T001",
    taskClass: "unknown",
    sessionId: "s",
    source: "local",
    verifyPassed: false,
    reviewPassed: true,
    findings: ["verify failed: pnpm run test (exit 1)"],
    relatedFiles: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    occurrences: 1,
    ...overrides
  };
}

describe("consecutiveFailures", () => {
  it("counts the trailing failure streak for the task only", () => {
    const state = stateWith({
      stepHistory: [
        { taskId: "T001", action: "checkpoint-failed", at: NOW },
        { taskId: "T002", action: "checkpoint-passed", at: NOW },
        { taskId: "T001", action: "checkpoint-failed", at: NOW }
      ]
    });
    expect(consecutiveFailures(state, "T001")).toBe(2);
  });

  it("a pass for the task resets the streak", () => {
    const state = stateWith({
      stepHistory: [
        { taskId: "T001", action: "checkpoint-failed", at: NOW },
        { taskId: "T001", action: "checkpoint-passed", at: NOW },
        { taskId: "T001", action: "checkpoint-failed", at: NOW }
      ]
    });
    expect(consecutiveFailures(state, "T001")).toBe(1);
  });
});

describe("decideAdaptiveAction", () => {
  it("below the threshold does nothing", () => {
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES - 1) });
    expect(decideAdaptiveAction({ state, task: task("T001"), findings: [] })).toEqual({ action: "none" });
  });

  it("at the threshold injects a remediation task scoped to the failing task", () => {
    const failing = task("T001", {
      allowedFiles: ["src/x.ts"],
      validationCommands: ["pnpm run test"],
      riskLevel: "medium"
    });
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES) });
    const decision = decideAdaptiveAction({ state, task: failing, findings: ["verify failed: x"] });
    expect(decision.action).toBe("inject-remediation");
    if (decision.action === "inject-remediation") {
      expect(decision.remediationTask.id).toBe("R-T001-1");
      expect(decision.remediationTask.allowedFiles).toEqual(["src/x.ts"]);
      expect(decision.remediationTask.validationCommands).toEqual(["pnpm run test"]);
      expect(decision.remediationTask.riskLevel).toBe("medium");
      expect(decision.remediationTask.description).toContain("verify failed: x");
    }
  });

  it("escalates once the injection cap is spent", () => {
    const state = stateWith({
      stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES),
      injectedTasks: [task("R-T001-1")]
    });
    const decision = decideAdaptiveAction({ state, task: task("T001"), findings: [] });
    expect(decision.action).toBe("escalation-directive");
  });

  it("escalates at the hard failure threshold", () => {
    const state = stateWith({ stepHistory: failures("T001", ESCALATION_AFTER_FAILURES) });
    expect(decideAdaptiveAction({ state, task: task("T001"), findings: [] }).action).toBe(
      "escalation-directive"
    );
  });

  it("a failing remediation task escalates instead of nesting remediations", () => {
    const remediation = task("R-T001-1");
    const state = stateWith({
      currentTaskId: "R-T001-1",
      injectedTasks: [remediation],
      stepHistory: failures("R-T001-1", REMEDIATION_AFTER_FAILURES)
    });
    expect(decideAdaptiveAction({ state, task: remediation, findings: [] }).action).toBe(
      "escalation-directive"
    );
  });

  it("is deterministic: same input yields the same decision", () => {
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES) });
    const input = { state, task: task("T001"), findings: ["b", "a", "b"] };
    expect(decideAdaptiveAction(input)).toEqual(decideAdaptiveAction(input));
  });
});

describe("synthesizeRemediationTask", () => {
  it("dedupes, sorts, and truncates findings into the description", () => {
    const remediation = synthesizeRemediationTask(task("T004"), ["b finding", "a finding", "b finding"], 1);
    expect(remediation.id).toBe("R-T004-1");
    expect(remediation.description).toBe(
      ["Resolve the findings that failed checkpoint for T004:", "- a finding", "- b finding"].join("\n")
    );
  });
});

describe("applyAdaptiveDecision + effectiveGraph", () => {
  it("injection points the pipeline at the remediation task and logs the decision", () => {
    const failing = task("T001");
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES) });
    const decision = decideAdaptiveAction({ state, task: failing, findings: ["f"] });
    const adapted = applyAdaptiveDecision(state, decision, "T001", NOW);

    expect(adapted.currentTaskId).toBe("R-T001-1");
    expect(adapted.taskIds).toEqual(["R-T001-1", "T001", "T002"]);
    expect(adapted.injectedTasks?.map((entry) => entry.id)).toEqual(["R-T001-1"]);
    expect(adapted.decisionLog).toHaveLength(1);
    expect(adapted.stepHistory.at(-1)).toMatchObject({ taskId: "R-T001-1", action: "task-injected" });
    // Purity: the input state is untouched.
    expect(state.currentTaskId).toBe("T001");
    expect(state.injectedTasks).toBeUndefined();
  });

  it("effectiveGraph sequences the remediation before the failing task without mutating the input", () => {
    const graph = { tasks: [task("T001"), task("T002", { dependsOn: ["T001"] })] };
    const state = stateWith({ injectedTasks: [task("R-T001-1")] });

    const merged = effectiveGraph(graph, state);
    const { ordered } = orderTasks(merged);

    expect(ordered.map((entry) => entry.id)).toEqual(["R-T001-1", "T001", "T002"]);
    expect(graph.tasks[0]!.dependsOn).toEqual([]);
    expect(graph.tasks).toHaveLength(2);
  });

  it("after the remediation passes, advance returns to the original task", () => {
    const graph = { tasks: [task("T001"), task("T002", { dependsOn: ["T001"] })] };
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES) });
    const decision = decideAdaptiveAction({ state, task: task("T001"), findings: ["f"] });
    const adapted = applyAdaptiveDecision(state, decision, "T001", NOW);
    const merged = effectiveGraph(graph, adapted);

    expect(currentTask(merged, adapted)?.id).toBe("R-T001-1");
    const afterRemediation = advance(adapted, merged, { verifyPassed: true, reviewPassed: true }, NOW);
    expect(afterRemediation.currentTaskId).toBe("T001");
  });

  it("returns the graph object untouched when nothing was injected", () => {
    const graph = { tasks: [task("T001")] };
    expect(effectiveGraph(graph, stateWith())).toBe(graph);
  });
});

describe("evidenceRequirements", () => {
  it("high risk or recurring patterns tighten evidence; low risk does not", () => {
    expect(evidenceRequirements(task("T001", { riskLevel: "high" }), []).strictEvidence).toBe(true);
    expect(evidenceRequirements(task("T001", { riskLevel: "low" }), []).strictEvidence).toBe(false);
    expect(
      evidenceRequirements(task("T001", { riskLevel: "low" }), [pattern({ occurrences: 2 })]).strictEvidence
    ).toBe(true);
  });

  it("surfaces known failure modes from patterns", () => {
    const { knownFailureModes } = evidenceRequirements(task("T001"), [
      pattern({ findings: ["a", "b"] }),
      pattern({ id: "fp_2", findings: ["a", "c"] })
    ]);
    expect(knownFailureModes).toEqual(["a", "b", "c"]);
  });
});

describe("renderAdaptationBlock", () => {
  it("renders the injection block deterministically and returns null for none", () => {
    const state = stateWith({ stepHistory: failures("T001", REMEDIATION_AFTER_FAILURES) });
    const decision = decideAdaptiveAction({ state, task: task("T001"), findings: ["f"] });
    const block = renderAdaptationBlock("T001", decision);
    expect(block).toContain("BEGIN_VISP_ADAPTATION");
    expect(block).toContain("action: inject-remediation");
    expect(block).toContain("remediation_task: R-T001-1");
    expect(block).toContain("END_VISP_ADAPTATION");
    expect(renderAdaptationBlock("T001", { action: "none" })).toBeNull();
  });
});
