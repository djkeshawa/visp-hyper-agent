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

function scoutAttempts(taskClass: string, passes: number, samples: number): TelemetryAttempt[] {
  return Array.from({ length: samples }, (_, index) => ({
    taskId: `T${index}`,
    taskClass,
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
      task: { id: "T001", riskLevel: "medium" },
      attempts: scoutAttempts("medium", 30, 30),
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
      task: { id: "T001", riskLevel: "medium" },
      attempts: scoutAttempts("medium", 29, 30),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.evidence.lowerConfidenceBound).toBeLessThan(DOWNGRADE_MIN_WILSON_LOWER_BOUND);
    expect(result.reason).toContain("Wilson lower bound");
  });

  it("rejects perfect but undersized evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts: scoutAttempts("medium", 29, 29),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("29/30");
  });

  it("does not make an unconditional cheap choice for low risk", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", riskLevel: "low" },
      attempts: [],
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("insufficient evidence");
  });

  it("lets active quarantine override otherwise sufficient evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts: scoutAttempts("medium", 30, 30),
      routingState: { quarantines: [{ taskClass: "medium", untilSessionCount: 5 }], decisions: [] },
      sessionCount: 4
    });
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("quarantined");
  });

  it("renders sample counts and confidence evidence", () => {
    const result = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts: scoutAttempts("medium", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });
    expect(renderModelRouting(result)).toContain("wilson_lower_bound=");
    expect(renderModelRouting(result)).toContain("passes=30");
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
      taskClass: "medium",
      sessionCount: 5,
      now: "2026-07-11T00:00:00.000Z"
    });
    expect(state.quarantines).toEqual([]);
    expect(next.quarantines).toEqual([{ taskClass: "medium", untilSessionCount: 5 + QUARANTINE_SESSIONS }]);
    expect(next.decisions[0]?.tier).toBe(STRONGEST_TIER);
  });

  it("extends an existing quarantine to the later boundary", () => {
    const next = escalate({
      state: { quarantines: [{ taskClass: "medium", untilSessionCount: 5 }], decisions: [] },
      taskId: "T002",
      taskClass: "medium",
      sessionCount: 4,
      now: "2026-07-11T00:00:00.000Z"
    });
    expect(next.quarantines).toEqual([{ taskClass: "medium", untilSessionCount: 7 }]);
  });
});
