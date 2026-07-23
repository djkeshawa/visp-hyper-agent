import { describe, expect, it } from "vitest";
import {
  CHEAP_TIER,
  DOWNGRADE_MIN_SAMPLES,
  DOWNGRADE_MIN_WILSON_LOWER_BOUND,
  QUARANTINE_SESSIONS,
  STRONGEST_TIER,
  computeSuggestedTier,
  escalate,
  renderModelRouting,
  wilsonLowerBound
} from "../src/routing/routing-engine.js";
import type { TelemetryAttempt } from "../src/telemetry/telemetry-store.js";
import type { RoutingState } from "../src/routing/routing-state.js";

const emptyState = (): RoutingState => ({ quarantines: [], decisions: [] });

function scoutAttempts(
  taskClass: TelemetryAttempt["taskClass"],
  passes: number,
  samples: number
): TelemetryAttempt[] {
  return Array.from({ length: samples }, (_, index) => ({
    taskId: `T${index}`,
    taskClass,
    riskLevel: "medium",
    riskFactors: [],
    tier: CHEAP_TIER,
    attempt: 1,
    verifyPassed: index < passes,
    reviewPassed: index < passes,
    firstAttempt: true,
    sessionId: `vh_${index}`,
    at: "2026-07-11T00:00:00.000Z"
  }));
}

describe("evidence-first routing", () => {
  it("requires 30 comparable successes and a strong Wilson lower bound", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(DOWNGRADE_MIN_SAMPLES).toBe(30);
    expect(result.suggestedTier).toBe(CHEAP_TIER);
    expect(result.evidence.lowerConfidenceBound).toBeGreaterThan(DOWNGRADE_MIN_WILSON_LOWER_BOUND);
    expect(result.reason).toContain("experimental evidence");
  });

  it("rejects 29/30 because its lower confidence bound is too weak", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 29, 30),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.evidence.lowerConfidenceBound).toBeLessThan(DOWNGRADE_MIN_WILSON_LOWER_BOUND);
    expect(result.reason).toContain("Wilson lower bound");
  });

  it("rejects perfect but undersized evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 29, 29),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("29/30");
  });

  it("does not make an unconditional cheap choice for low risk", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "localized_bug", riskLevel: "low", riskFactors: [] },
      attempts: [],
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("insufficient evidence");
  });

  it("lets active quarantine override otherwise sufficient evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: {
        quarantines: [{ taskClass: "bounded_feature", untilSessionCount: 5 }],
        decisions: []
      },
      sessionCount: 4
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("quarantined");
  });

  it("renders sample counts and confidence evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(renderModelRouting(result)).toContain("wilson_lower_bound=");
    expect(renderModelRouting(result)).toContain("passes=30");
  });

  it("keeps task class independent when two tasks have the same risk level", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "documentation", riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.taskClass).toBe("documentation");
    expect(result.riskLevel).toBe("medium");
    expect(result.evidence.samples).toBe(0);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
  });

  it("keeps unavailable task class null and excludes classified evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: null, riskLevel: "medium", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.taskClass).toBeNull();
    expect(result.riskLevel).toBe("medium");
    expect(result.evidence.samples).toBe(0);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
  });

  it("uses high risk to tighten routing even with sufficient same-class evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "high", riskFactors: [] },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.evidence.samples).toBe(30);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("high risk");
  });
});

describe("Wilson calculation", () => {
  it("handles empty and known boundary values", () => {
    expect(wilsonLowerBound(0, 0)).toBeNull();
    expect(wilsonLowerBound(30, 30)).toBeCloseTo(0.886, 3);
    expect(wilsonLowerBound(29, 30)).toBeCloseTo(0.833, 3);
  });
});

describe("quality recovery", () => {
  it("adds a quarantine and decision without mutating the input", () => {
    const state = emptyState();
    const next = escalate({
      state,
      taskId: "T001",
      taskClass: "bounded_feature",
      sessionCount: 5,
      now: "2026-07-11T00:00:00.000Z"
    });
    expect(state.quarantines).toEqual([]);
    expect(next.quarantines).toEqual([
      { taskClass: "bounded_feature", untilSessionCount: 5 + QUARANTINE_SESSIONS }
    ]);
    expect(next.decisions[0]?.tier).toBe(STRONGEST_TIER);
  });

  it("extends an existing quarantine to the later boundary", () => {
    const next = escalate({
      state: {
        quarantines: [{ taskClass: "bounded_feature", untilSessionCount: 5 }],
        decisions: []
      },
      taskId: "T002",
      taskClass: "bounded_feature",
      sessionCount: 4,
      now: "2026-07-11T00:00:00.000Z"
    });
    expect(next.quarantines).toEqual([{ taskClass: "bounded_feature", untilSessionCount: 7 }]);
  });
});
