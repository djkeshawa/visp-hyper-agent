import { describe, expect, it } from "vitest";
import {
  CHEAP_TIER,
  DOWNGRADE_MIN_PASS_RATE,
  DOWNGRADE_MIN_SAMPLES,
  QUARANTINE_SESSIONS,
  STRONGEST_TIER,
  computeSuggestedTier,
  escalate
} from "../src/routing/routing-engine.js";
import type { TelemetryAttempt } from "../src/telemetry/telemetry-store.js";
import type { RoutingState } from "../src/routing/routing-state.js";

function emptyRoutingState(): RoutingState {
  return { quarantines: [], decisions: [] };
}

/**
 * Build `total` first-attempt CHEAP_TIER ("scout") attempts for `taskClass`, of
 * which exactly `pass` are fully passing (verifyPassed && reviewPassed).
 * downgradeEvidence only counts attempts where tier === CHEAP_TIER AND
 * firstAttempt === true AND taskClass matches, so every attempt is built that way.
 */
function scoutAttempts(taskClass: string, pass: number, total: number): TelemetryAttempt[] {
  const attempts: TelemetryAttempt[] = [];
  for (let i = 0; i < total; i += 1) {
    const passing = i < pass;
    attempts.push({
      taskId: "T001",
      taskClass,
      tier: CHEAP_TIER,
      attempt: 1,
      verifyPassed: passing,
      // failing attempts fail review so they do not count toward the pass tally
      reviewPassed: passing,
      firstAttempt: true,
      sessionId: "vh_test",
      at: new Date().toISOString()
    });
  }
  return attempts;
}

describe("computeSuggestedTier — quality-first downgrade boundaries", () => {
  it("exactly 90% pass (9/10) for medium with no quarantine → CHEAP_TIER (>= boundary inclusive)", () => {
    const attempts = scoutAttempts("medium", 9, 10);
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.evidence.samples).toBe(10);
    expect(suggestion.evidence.passRate).toBe(0.9);
    // confirm we are testing exactly the boundary constant
    expect(suggestion.evidence.passRate).toBe(DOWNGRADE_MIN_PASS_RATE);
    expect(suggestion.reason).toContain("90%");
  });

  it("80% pass (8/10) for medium → STRONGEST_TIER with 'below 90%' reason", () => {
    const attempts = scoutAttempts("medium", 8, 10);
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.evidence.samples).toBe(10);
    expect(suggestion.evidence.passRate).toBeCloseTo(0.8, 10);
    expect(suggestion.reason).toContain("below 90%");
  });

  it("exactly DOWNGRADE_MIN_SAMPLES at 100% (3/3) → CHEAP_TIER", () => {
    const attempts = scoutAttempts("medium", DOWNGRADE_MIN_SAMPLES, DOWNGRADE_MIN_SAMPLES);
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.evidence.samples).toBe(DOWNGRADE_MIN_SAMPLES);
    expect(suggestion.evidence.passRate).toBe(1);
    expect(suggestion.reason).toContain(`${DOWNGRADE_MIN_SAMPLES} samples`);
  });

  it("one below DOWNGRADE_MIN_SAMPLES at 100% (2/2) → STRONGEST_TIER (insufficient evidence)", () => {
    const samples = DOWNGRADE_MIN_SAMPLES - 1;
    const attempts = scoutAttempts("medium", samples, samples);
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    // perfect pass rate, but not enough samples to earn the downgrade
    expect(suggestion.evidence.passRate).toBe(1);
    expect(suggestion.evidence.samples).toBe(samples);
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.reason).toContain(`${samples}/${DOWNGRADE_MIN_SAMPLES}`);
  });

  it("0 samples → STRONGEST_TIER (insufficient) and passRate === null (no divide-by-zero)", () => {
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts: [],
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.evidence.samples).toBe(0);
    expect(suggestion.evidence.passRate).toBeNull();
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.reason).toContain(`0/${DOWNGRADE_MIN_SAMPLES}`);
  });

  it("low risk → always CHEAP_TIER baseline, ignoring evidence", () => {
    // Even with zero (or contrary) evidence, low risk is cheap by default.
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "low" },
      attempts: scoutAttempts("low", 0, 5),
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toBe("baseline: low risk");
    expect(suggestion.evidence.samples).toBe(0);
    expect(suggestion.evidence.passRate).toBeNull();
  });
});

describe("computeSuggestedTier — quarantine boundary (quality wins)", () => {
  it("quarantine active (untilSessionCount=5 > sessionCount=4) → STRONGEST_TIER despite perfect evidence", () => {
    const attempts = scoutAttempts("medium", 5, 5); // perfect downgrade evidence
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 5 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState,
      sessionCount: 4
    });
    // evidence is perfect but quarantine wins (quality recovers unconditionally)
    expect(suggestion.evidence.passRate).toBe(1);
    expect(suggestion.evidence.samples).toBe(5);
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("quarantined until session 5");
  });

  it("quarantine expired at boundary (untilSessionCount=5, sessionCount=5) → strong evidence yields CHEAP_TIER", () => {
    const attempts = scoutAttempts("medium", 5, 5);
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 5 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState,
      sessionCount: 5
    });
    // 5 > 5 is false → not quarantined; evidence-based downgrade re-enabled
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toContain("samples");
    expect(suggestion.reason).not.toContain("quarantined");
  });
});

describe("escalate — unconditional quality recovery", () => {
  it("on empty state → adds quarantine untilSessionCount = sessionCount + QUARANTINE_SESSIONS and one decision", () => {
    const sessionCount = 5;
    const next = escalate({
      state: emptyRoutingState(),
      taskId: "T001",
      taskClass: "medium",
      sessionCount,
      now: "2026-06-17T00:00:00.000Z"
    });
    expect(next.quarantines).toEqual([
      { taskClass: "medium", untilSessionCount: sessionCount + QUARANTINE_SESSIONS }
    ]);
    expect(next.decisions).toHaveLength(1);
    expect(next.decisions[0]?.taskId).toBe("T001");
    expect(next.decisions[0]?.taskClass).toBe("medium");
    expect(next.decisions[0]?.tier).toBe(STRONGEST_TIER);
    expect(next.decisions[0]?.reason).toBe("checkpoint failure escalation");
    expect(next.decisions[0]?.at).toBe("2026-06-17T00:00:00.000Z");
  });

  it("does not mutate the input state", () => {
    const state = emptyRoutingState();
    const next = escalate({
      state,
      taskId: "T001",
      taskClass: "medium",
      sessionCount: 1,
      now: "2026-06-17T00:00:00.000Z"
    });
    expect(state.quarantines).toEqual([]);
    expect(state.decisions).toEqual([]);
    expect(next).not.toBe(state);
  });

  it("double escalation extends via Math.max: existing 10, escalate at sessionCount=3 → stays 10 (max(10,6))", () => {
    const state: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 10 }],
      decisions: []
    };
    const sessionCount = 3;
    const next = escalate({
      state,
      taskId: "T002",
      taskClass: "medium",
      sessionCount,
      now: "2026-06-17T01:00:00.000Z"
    });
    // max(existing 10, sessionCount 3 + QUARANTINE_SESSIONS 3 = 6) = 10
    expect(sessionCount + QUARANTINE_SESSIONS).toBe(6);
    expect(next.quarantines).toEqual([{ taskClass: "medium", untilSessionCount: 10 }]);
    // no duplicate quarantine entry created
    expect(next.quarantines).toHaveLength(1);
    // decision is still appended
    expect(next.decisions).toHaveLength(1);
  });

  it("double escalation extends via Math.max: existing 5, escalate at sessionCount=4 → becomes 7 (max(5,7))", () => {
    const state: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 5 }],
      decisions: [
        {
          taskId: "T001",
          taskClass: "medium",
          tier: STRONGEST_TIER,
          reason: "checkpoint failure escalation",
          at: "2026-06-17T00:00:00.000Z"
        }
      ]
    };
    const sessionCount = 4;
    const next = escalate({
      state,
      taskId: "T003",
      taskClass: "medium",
      sessionCount,
      now: "2026-06-17T02:00:00.000Z"
    });
    // max(existing 5, sessionCount 4 + QUARANTINE_SESSIONS 3 = 7) = 7
    expect(sessionCount + QUARANTINE_SESSIONS).toBe(7);
    expect(next.quarantines).toEqual([{ taskClass: "medium", untilSessionCount: 7 }]);
    expect(next.quarantines).toHaveLength(1);
    // existing decision preserved, new one appended
    expect(next.decisions).toHaveLength(2);
    expect(next.decisions[1]?.taskId).toBe("T003");
  });

  it("escalating a different taskClass leaves the existing quarantine untouched and adds a new one", () => {
    const state: RoutingState = {
      quarantines: [{ taskClass: "high", untilSessionCount: 9 }],
      decisions: []
    };
    const next = escalate({
      state,
      taskId: "T004",
      taskClass: "medium",
      sessionCount: 2,
      now: "2026-06-17T03:00:00.000Z"
    });
    expect(next.quarantines).toContainEqual({ taskClass: "high", untilSessionCount: 9 });
    expect(next.quarantines).toContainEqual({
      taskClass: "medium",
      untilSessionCount: 2 + QUARANTINE_SESSIONS
    });
    expect(next.quarantines).toHaveLength(2);
  });
});
