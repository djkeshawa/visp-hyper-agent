import type { TelemetryAttempt } from "../telemetry/telemetry-store.js";
import type { RoutingDecision, RoutingState } from "./routing-state.js";

export const DOWNGRADE_MIN_SAMPLES = 3;
export const DOWNGRADE_MIN_PASS_RATE = 0.9;
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
  evidence: { samples: number; passRate: number | null };
};

function downgradeEvidence(
  attempts: TelemetryAttempt[],
  taskClass: string
): { samples: number; passRate: number | null } {
  const relevant = attempts.filter(
    (entry) => entry.taskClass === taskClass && entry.tier === CHEAP_TIER && entry.firstAttempt === true
  );
  const samples = relevant.length;
  if (samples === 0) {
    return { samples: 0, passRate: null };
  }
  const passed = relevant.filter((entry) => entry.verifyPassed && entry.reviewPassed).length;
  return { samples, passRate: passed / samples };
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

  // 1 + 2. Baseline. Low risk is cheap by default; nothing else to decide.
  if (taskClass === "low") {
    return {
      taskId,
      taskClass,
      suggestedTier: CHEAP_TIER,
      reason: "baseline: low risk",
      evidence: { samples: 0, passRate: null }
    };
  }

  const evidence = downgradeEvidence(attempts, taskClass);

  // 3. Active quarantine forces strongest tier — quality recovers unconditionally.
  const quarantine = routingState.quarantines.find((entry) => entry.taskClass === taskClass);
  if (quarantine && quarantine.untilSessionCount > sessionCount) {
    return {
      taskId,
      taskClass,
      suggestedTier: STRONGEST_TIER,
      reason: `quarantined until session ${quarantine.untilSessionCount}`,
      evidence
    };
  }

  // 4. Evidence-gated downgrade.
  if (evidence.samples >= DOWNGRADE_MIN_SAMPLES && evidence.passRate !== null) {
    if (evidence.passRate >= DOWNGRADE_MIN_PASS_RATE) {
      return {
        taskId,
        taskClass,
        suggestedTier: CHEAP_TIER,
        reason: `evidence: ${evidence.samples} samples at ${pct(evidence.passRate)} first-attempt pass`,
        evidence
      };
    }
    return {
      taskId,
      taskClass,
      suggestedTier: STRONGEST_TIER,
      reason: `pass rate ${pct(evidence.passRate)} below 90%`,
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

  const existing = state.quarantines.find((entry) => entry.taskClass === taskClass);
  const quarantines = existing
    ? state.quarantines.map((entry) =>
        entry.taskClass === taskClass
          ? { ...entry, untilSessionCount: Math.max(entry.untilSessionCount, untilSessionCount) }
          : entry
      )
    : [...state.quarantines, { taskClass, untilSessionCount }];

  const decision: RoutingDecision = {
    taskId,
    taskClass,
    tier: STRONGEST_TIER,
    reason: "checkpoint failure escalation",
    at: now
  };

  return {
    quarantines,
    decisions: [...state.decisions, decision]
  };
}

export function renderModelRouting(suggestion: RoutingSuggestion): string {
  const passRate =
    suggestion.evidence.passRate === null ? "n/a" : `${Math.round(suggestion.evidence.passRate * 100)}%`;
  return [
    "BEGIN_VISP_MODEL_ROUTING",
    `task: ${suggestion.taskId}`,
    `suggested_tier: ${suggestion.suggestedTier}`,
    `reason: ${suggestion.reason}`,
    `evidence: samples=${suggestion.evidence.samples} pass_rate=${passRate}`,
    "END_VISP_MODEL_ROUTING"
  ].join("\n");
}
