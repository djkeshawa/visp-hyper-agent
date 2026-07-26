import { describe, expect, it } from "vitest";
import {
  CHEAP_TIER,
  DOWNGRADE_MIN_SAMPLES,
  DOWNGRADE_MIN_WILSON_LOWER_BOUND,
  QUARANTINE_SESSIONS,
  STRONGEST_TIER,
  computeSuggestedTier as computeSuggestedTierRaw,
  escalate,
  renderModelRouting,
  wilsonLowerBound
} from "../src/routing/routing-engine.js";
import type { TelemetryAttempt } from "../src/telemetry/telemetry-store.js";
import type { RoutingState } from "../src/routing/routing-state.js";

const emptyState = (): RoutingState => ({ quarantines: [], decisions: [] });
const TEST_COHORT = {
  assuranceProfile: "behavioral" as const,
  host: "codex",
  modelId: "test-scout-model",
  modelVersion: "2026-07",
  projectPreset: "typescript"
};

function computeSuggestedTier(
  input: Parameters<typeof computeSuggestedTierRaw>[0]
): ReturnType<typeof computeSuggestedTierRaw> {
  return computeSuggestedTierRaw({
    ...input,
    task: { assuranceProfile: "behavioral", ...input.task },
    cohort: { ...TEST_COHORT, ...input.cohort }
  });
}

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
    assuranceProfile: "behavioral",
    host: TEST_COHORT.host,
    modelId: TEST_COHORT.modelId,
    modelVersion: TEST_COHORT.modelVersion,
    projectPreset: TEST_COHORT.projectPreset,
    protocolVersion: "local-checked/1.0",
    kitVersion: "none",
    hyperVersion: "0.3.0",
    tier: CHEAP_TIER,
    attempt: 1,
    verifyPassed: index < passes,
    reviewPassed: index < passes,
    verdict: index < passes ? "passed" : "failed",
    evidenceSource: "local",
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
      attempts: scoutAttempts("bounded_feature", 30, 30).map((attempt) => ({
        ...attempt,
        riskLevel: "high"
      })),
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.evidence.samples).toBe(30);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("high risk");
  });

  it("excludes inconclusive attempts from pass-rate samples and reports them separately", () => {
    const inconclusive = scoutAttempts("bounded_feature", 10, 10).map((attempt) => ({
      ...attempt,
      verifyPassed: false,
      reviewPassed: false,
      verdict: "inconclusive" as const
    }));
    const result = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: [...scoutAttempts("bounded_feature", 30, 30), ...inconclusive],
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.evidence).toMatchObject({ samples: 30, passes: 30, inconclusive: 10 });
    expect(result.suggestedTier).toBe(CHEAP_TIER);
    expect(renderModelRouting(result)).toContain("inconclusive=10");
  });

  it("does not mix evidence across host, model, version, preset, profile, or risk cohorts", () => {
    const result = computeSuggestedTier({
      task: {
        id: "T001",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        riskFactors: [],
        assuranceProfile: "behavioral"
      },
      cohort: {
        host: "codex",
        modelId: "scout",
        modelVersion: "2026-07",
        projectPreset: "typescript",
        assuranceProfile: "behavioral"
      },
      attempts: scoutAttempts("bounded_feature", 30, 30),
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.evidence.samples).toBe(0);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
  });

  it("never recommends the cheap tier for critical assurance", () => {
    const attempts = scoutAttempts("bounded_feature", 30, 30).map((attempt) => ({
      ...attempt,
      assuranceProfile: "critical" as const
    }));
    const result = computeSuggestedTier({
      task: {
        id: "T001",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        riskFactors: [],
        assuranceProfile: "critical"
      },
      attempts,
      routingState: emptyState(),
      sessionCount: 0
    });

    expect(result.evidence.samples).toBe(30);
    expect(result.suggestedTier).toBe(STRONGEST_TIER);
    expect(result.reason).toContain("critical assurance");
  });

  it("fails safe when authoritative risk or assurance cohort data is unavailable", () => {
    for (const task of [
      { id: "T001", taskClass: "bounded_feature" as const, riskLevel: null, assuranceProfile: "behavioral" as const },
      { id: "T001", taskClass: "bounded_feature" as const, riskLevel: "medium" as const, assuranceProfile: null }
    ]) {
      const result = computeSuggestedTierRaw({
        task,
        cohort: TEST_COHORT,
        attempts: scoutAttempts("bounded_feature", 30, 30),
        routingState: emptyState(),
        sessionCount: 0
      });
      expect(result.suggestedTier).toBe(STRONGEST_TIER);
      expect(result.evidence.samples).toBe(0);
      expect(result.reason).toContain("incomplete routing cohort");
    }
  });

  it("fails safe for placeholder model identity or missing model version", () => {
    for (const cohort of [
      { ...TEST_COHORT, modelId: CHEAP_TIER },
      { ...TEST_COHORT, modelVersion: null }
    ]) {
      const result = computeSuggestedTierRaw({
        task: {
          id: "T001",
          taskClass: "bounded_feature",
          riskLevel: "medium",
          assuranceProfile: "behavioral"
        },
        cohort,
        attempts: scoutAttempts("bounded_feature", 30, 30),
        routingState: emptyState(),
        sessionCount: 0
      });
      expect(result.suggestedTier).toBe(STRONGEST_TIER);
      expect(result.evidence.samples).toBe(0);
      expect(result.reason).toContain("incomplete routing cohort");
    }
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
