import type { TelemetryAttempt } from "../telemetry/telemetry-store.js";
import { boundRoutingState, type RoutingDecision, type RoutingState } from "./routing-state.js";

export const DOWNGRADE_MIN_SAMPLES = 30;
export const DOWNGRADE_MIN_WILSON_LOWER_BOUND = 0.85;
export const QUARANTINE_SESSIONS = 3;

/**
 * The fleet's strongest *coding* tier. The coordinator orchestrates but does
 * not write code, so escalation and quality recovery always target the
 * implementer tier. The cheap tier is the scout.
 */
export const STRONGEST_TIER = "implementer";
export const CHEAP_TIER = "scout";

export type RoutingSuggestion = {
  taskId: string;
  taskClass: string;
  suggestedTier: string;
  reason: string;
  evidence: { samples: number; passes: number; passRate: number | null; lowerConfidenceBound: number | null };
};

/** 95% Wilson score lower bound for a binomial proportion. */
export function wilsonLowerBound(passes: number, samples: number, z = 1.959963984540054): number | null {
  if (samples <= 0) return null;
  const p = passes / samples;
  const z2 = z * z;
  const denominator = 1 + z2 / samples;
  const centre = p + z2 / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * samples)) / samples);
  return (centre - margin) / denominator;
}

function downgradeEvidence(
  attempts: TelemetryAttempt[],
  taskClass: string
): RoutingSuggestion["evidence"] {
  const relevant = attempts.filter(
    (entry) =>
      entry.taskKey !== undefined &&
      entry.taskClass === taskClass &&
      entry.tier === CHEAP_TIER &&
      entry.firstAttempt === true
  );
  const samples = relevant.length;
  if (samples === 0) {
    return { samples: 0, passes: 0, passRate: null, lowerConfidenceBound: null };
  }
  const passed = relevant.filter((entry) => entry.verifyPassed && entry.reviewPassed).length;
  return {
    samples,
    passes: passed,
    passRate: passed / samples,
    lowerConfidenceBound: wilsonLowerBound(passed, samples)
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Pure model-tier routing. THE INVARIANT: cost savings must be earned by
 * evidence; quality recovers unconditionally. An active quarantine forces the
 * strongest tier regardless of how good the downgrade evidence looks.
 */
export function computeSuggestedTier(input: {
  task: { id: string; riskLevel?: string };
  attempts: TelemetryAttempt[];
  routingState: RoutingState;
  sessionCount: number;
}): RoutingSuggestion {
  const { task, attempts, routingState, sessionCount } = input;
  const taskId = task.id;
  const taskClass = task.riskLevel ?? "unknown";

  const evidence = downgradeEvidence(attempts, taskClass);

  // 3. Active quarantine forces strongest tier — quality recovers unconditionally.
  const quarantine = routingState.quarantines
    .filter((entry) => entry.taskClass === taskClass)
    .sort((left, right) => right.untilSessionCount - left.untilSessionCount)[0];
  if (quarantine && quarantine.untilSessionCount >= sessionCount) {
    return {
      taskId,
      taskClass,
      suggestedTier: STRONGEST_TIER,
      reason: `quarantined until session ${quarantine.untilSessionCount}`,
      evidence
    };
  }

  // 4. Evidence-gated downgrade.
  if (evidence.samples >= DOWNGRADE_MIN_SAMPLES && evidence.lowerConfidenceBound !== null) {
    if (evidence.lowerConfidenceBound >= DOWNGRADE_MIN_WILSON_LOWER_BOUND) {
      return {
        taskId,
        taskClass,
        suggestedTier: CHEAP_TIER,
        reason: `experimental evidence: ${evidence.samples} samples, ${pct(evidence.lowerConfidenceBound)} Wilson lower bound`,
        evidence
      };
    }
    return {
      taskId,
      taskClass,
      suggestedTier: STRONGEST_TIER,
      reason: `Wilson lower bound ${pct(evidence.lowerConfidenceBound)} below ${pct(DOWNGRADE_MIN_WILSON_LOWER_BOUND)}`,
      evidence
    };
  }

  return {
    taskId,
    taskClass,
    suggestedTier: STRONGEST_TIER,
    reason: `insufficient evidence for downgrade (${evidence.samples}/${DOWNGRADE_MIN_SAMPLES} samples)`,
    evidence
  };
}

/**
 * Pure escalation: returns a NEW state. Upserts a quarantine for `taskClass`
 * (extending an existing one to the later expiry) and appends a decision. A
 * checkpoint failure is unconditional — no evidence required to recover quality.
 */
export function escalate(input: {
  state: RoutingState;
  taskId: string;
  taskClass: string;
  sessionCount: number;
  now: string;
}): RoutingState {
  const { state, taskId, taskClass, sessionCount, now } = input;
  const untilSessionCount = sessionCount + QUARANTINE_SESSIONS;

  const existingExpiry = state.quarantines
    .filter((entry) => entry.taskClass === taskClass)
    .reduce((maximum, entry) => Math.max(maximum, entry.untilSessionCount), 0);
  const quarantines = [
    ...state.quarantines.filter((entry) => entry.taskClass !== taskClass),
    { taskClass, untilSessionCount: Math.max(existingExpiry, untilSessionCount) }
  ];

  const decision: RoutingDecision = {
    taskId,
    taskClass,
    tier: STRONGEST_TIER,
    reason: "checkpoint failure escalation",
    at: now
  };

  return boundRoutingState({
    quarantines,
    decisions: [...state.decisions, decision]
  });
}

export function renderModelRouting(suggestion: RoutingSuggestion): string {
  const passRate =
    suggestion.evidence.passRate === null ? "n/a" : `${Math.round(suggestion.evidence.passRate * 100)}%`;
  const lowerBound = suggestion.evidence.lowerConfidenceBound === null
    ? "n/a"
    : `${Math.round(suggestion.evidence.lowerConfidenceBound * 100)}%`;
  return [
    "BEGIN_VISP_MODEL_ROUTING",
    `task: ${suggestion.taskId}`,
    `suggested_tier: ${suggestion.suggestedTier}`,
    `reason: ${suggestion.reason}`,
    `evidence: samples=${suggestion.evidence.samples} passes=${suggestion.evidence.passes} pass_rate=${passRate} wilson_lower_bound=${lowerBound}`,
    "END_VISP_MODEL_ROUTING"
  ].join("\n");
}
