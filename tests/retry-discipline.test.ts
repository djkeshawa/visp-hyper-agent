import { describe, expect, it } from "vitest";
import {
  ESCALATION_AFTER_FAILURES,
  REMEDIATION_AFTER_FAILURES,
  decideAdaptiveAction,
  failureFingerprint,
  failureFingerprintHistory
} from "../src/pipeline/adaptive-rules.js";
import { advance } from "../src/pipeline/pipeline-engine.js";
import type { PipelineState } from "../src/core/types.js";
import type { KitTask, KitTaskGraph } from "../src/kit/kit-schemas.js";

/**
 * P8-03 — a retry must change something.
 *
 * Hyper already bounded retries by a count: remediation after two consecutive
 * failures, escalation at three. A count cannot tell a genuine second attempt
 * apart from the same attempt repeated, so an agent could burn its whole budget
 * re-running one command against one unchanged defect. The research calls that
 * integral windup and prescribes the stronger rule these tests pin: the same
 * failure seen twice escalates, it does not retry.
 */

const TASK: KitTask = {
  id: "T001",
  title: "Add password reset",
  description: "d",
  dependsOn: [],
  status: "pending"
};

function stateWithFailures(fingerprints: (string | null)[]): PipelineState {
  return {
    taskIds: [TASK.id],
    currentTaskId: TASK.id,
    completed: [],
    stepHistory: fingerprints.map((fingerprint, index) => ({
      taskId: TASK.id,
      action: "checkpoint-failed" as const,
      at: `2026-07-30T00:0${index}:00.000Z`,
      ...(fingerprint === null ? {} : { failureFingerprint: fingerprint })
    })),
    decisionLog: [],
    injectedTasks: []
  };
}

const FINDINGS_A = ["test_checkout fails: two orders created"];
const FINDINGS_B = ["type error in OrderService.retry"];

describe("P8-03 retry discipline", () => {
  it("normalises phrasing, so a reworded identical failure is the same failure", () => {
    // The whole rule turns on this. Without normalisation a retry could buy
    // itself another attempt just by reporting the same defect differently.
    expect(failureFingerprint(["  Test_Checkout   FAILS: two orders created "])).toBe(
      failureFingerprint(["test_checkout fails: two orders created"])
    );
    // Order and duplicates likewise.
    expect(failureFingerprint(["a", "b", "a"])).toBe(failureFingerprint(["b", "a"]));
    // But a genuinely different defect is a different fingerprint.
    expect(failureFingerprint(FINDINGS_A)).not.toBe(failureFingerprint(FINDINGS_B));
  });

  it("escalates immediately when the same failure repeats", () => {
    // Two failures, identical findings. The counter would allow a remediation
    // here; the fingerprint rule refuses because nothing changed.
    const state = stateWithFailures([failureFingerprint(FINDINGS_A), failureFingerprint(FINDINGS_A)]);
    const decision = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_A });
    expect(decision.action).toBe("escalation-directive");
    if (decision.action !== "escalation-directive") throw new Error("unreachable");
    expect(decision.rule).toBe("unchanged-failure-fingerprint");
    expect(decision.reason).toMatch(/would not change the evidence/u);
  });

  it("allows a retry when the evidence genuinely moved, and names what changed", () => {
    const state = stateWithFailures([failureFingerprint(FINDINGS_A), failureFingerprint(FINDINGS_B)]);
    const decision = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_B });
    expect(decision.action).toBe("inject-remediation");
    if (decision.action !== "inject-remediation") throw new Error("unreachable");
    expect(decision.changedInputs.length).toBeGreaterThan(0);
    expect(decision.changedInputs.join(" ")).toMatch(/findings changed/u);
  });

  it("the unchanged rule can escalate earlier than the counter would", () => {
    // Proves the rule is strictly stronger, not decorative: at two failures the
    // count-based path injects a remediation, and only the fingerprint check
    // turns that into an escalation.
    const changed = stateWithFailures([failureFingerprint(FINDINGS_A), failureFingerprint(FINDINGS_B)]);
    expect(decideAdaptiveAction({ state: changed, task: TASK, findings: FINDINGS_B }).action).toBe(
      "inject-remediation"
    );
    const repeated = stateWithFailures([failureFingerprint(FINDINGS_A), failureFingerprint(FINDINGS_A)]);
    expect(decideAdaptiveAction({ state: repeated, task: TASK, findings: FINDINGS_A }).action).toBe(
      "escalation-directive"
    );
    expect(REMEDIATION_AFTER_FAILURES).toBeLessThan(ESCALATION_AFTER_FAILURES);
  });

  it("a repeat that is not consecutive still counts as unchanged", () => {
    // A → B → A. The counter sees three consecutive failures and escalates
    // anyway, but the reason matters: this escalates because the evidence came
    // back unchanged, which is the diagnosis a human needs.
    const state = stateWithFailures([
      failureFingerprint(FINDINGS_A),
      failureFingerprint(FINDINGS_B),
      failureFingerprint(FINDINGS_A)
    ]);
    const decision = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_A });
    expect(decision.action).toBe("escalation-directive");
    if (decision.action !== "escalation-directive") throw new Error("unreachable");
    expect(decision.rule).toBe("unchanged-failure-fingerprint");
  });

  it("records written before P8-03 are not treated as a match", () => {
    // A null fingerprint means "cannot compare", not "same". Treating an
    // unreadable record as a repeat would escalate work that never actually
    // repeated.
    const state = stateWithFailures([null, failureFingerprint(FINDINGS_A)]);
    const decision = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_A });
    expect(decision.action).toBe("inject-remediation");
  });

  it("leaves the existing streak and cap behaviour intact", () => {
    // A single failure still does nothing.
    const one = stateWithFailures([failureFingerprint(FINDINGS_A)]);
    expect(decideAdaptiveAction({ state: one, task: TASK, findings: FINDINGS_A }).action).toBe("none");

    // Three distinct failures still hit the count-based escalation.
    const three = stateWithFailures([
      failureFingerprint(["x"]),
      failureFingerprint(["y"]),
      failureFingerprint(["z"])
    ]);
    const decision = decideAdaptiveAction({ state: three, task: TASK, findings: ["z"] });
    expect(decision.action).toBe("escalation-directive");
    if (decision.action !== "escalation-directive") throw new Error("unreachable");
    expect(decision.rule).toBe(`consecutive-failures>=${ESCALATION_AFTER_FAILURES}`);
  });

  it("advance records the fingerprint on failure and nothing on success", () => {
    const graph: KitTaskGraph = { tasks: [TASK] };
    const base = stateWithFailures([]);
    const failed = advance(
      base,
      graph,
      { verifyPassed: false, reviewPassed: true, detail: "d", failureFingerprint: "abc123" },
      "2026-07-30T00:00:00.000Z"
    );
    expect(failed.stepHistory.at(-1)?.failureFingerprint).toBe("abc123");

    const passed = advance(
      base,
      graph,
      { verifyPassed: true, reviewPassed: true, detail: "d" },
      "2026-07-30T00:01:00.000Z"
    );
    expect(passed.stepHistory.at(-1)?.action).toBe("checkpoint-passed");
    expect(passed.stepHistory.at(-1)?.failureFingerprint).toBeUndefined();
  });

  it("history reports uncomparable records as null rather than dropping them", () => {
    const state = stateWithFailures([null, "aaa", null]);
    expect(failureFingerprintHistory(state, TASK.id)).toEqual([null, "aaa", null]);
  });

  it("the decision stays pure — same inputs, same answer", () => {
    const state = stateWithFailures([failureFingerprint(FINDINGS_A), failureFingerprint(FINDINGS_A)]);
    const first = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_A });
    const second = decideAdaptiveAction({ state, task: TASK, findings: FINDINGS_A });
    expect(second).toEqual(first);
  });
});
