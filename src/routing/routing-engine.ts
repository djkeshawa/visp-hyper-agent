import type {
  AssuranceProfile,
  RiskFactor,
  RiskLevel,
  TaskClass
} from "../kit/workflow-action-protocol.js";
import type { TelemetryAttempt } from "../telemetry/telemetry-store.js";
import type { RoutingDecision, RoutingState } from "./routing-state.js";

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
  taskClass: TaskClass | null;
  riskLevel: RiskLevel | null;
  riskFactors: RiskFactor[] | null;
  suggestedTier: string;
  reason: string;
  evidence: {
    samples: number;
    passes: number;
    inconclusive: number;
    passRate: number | null;
    lowerConfidenceBound: number | null;
  };
};

export type RoutingEvidenceCohort = {
  assuranceProfile: AssuranceProfile | null;
  host: string;
  modelId: string;
  modelVersion: string | null;
  projectPreset: string;
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
  taskClass: TaskClass | null,
  riskLevel: RiskLevel | null,
  cohort: RoutingEvidenceCohort
): RoutingSuggestion["evidence"] {
  if (taskClass === null || incompleteDowngradeCohort(riskLevel, cohort).length > 0) {
    return { samples: 0, passes: 0, inconclusive: 0, passRate: null, lowerConfidenceBound: null };
  }
  const relevant = attempts.filter(
    (entry) =>
      entry.taskClass === taskClass &&
      entry.riskLevel === riskLevel &&
      entry.assuranceProfile === cohort.assuranceProfile &&
      entry.host === cohort.host &&
      entry.modelId === cohort.modelId &&
      entry.modelVersion === cohort.modelVersion &&
      entry.projectPreset === cohort.projectPreset &&
      entry.tier === CHEAP_TIER &&
      entry.firstAttempt === true
  );
  const inconclusive = relevant.filter((entry) => entry.verdict === "inconclusive").length;
  const decided = relevant.filter(
    (entry) => entry.verdict === "passed" || entry.verdict === "failed"
  );
  const samples = decided.length;
  if (samples === 0) {
    return { samples: 0, passes: 0, inconclusive, passRate: null, lowerConfidenceBound: null };
  }
  const passed = decided.filter((entry) => entry.verdict === "passed").length;
  return {
    samples,
    passes: passed,
    inconclusive,
    passRate: passed / samples,
    lowerConfidenceBound: wilsonLowerBound(passed, samples)
  };
}

const PLACEHOLDER_MODEL_IDS = new Set([
  "",
  "unknown",
  "unreported",
  "scout",
  "implementer",
  "coordinator"
]);

function incompleteDowngradeCohort(
  riskLevel: RiskLevel | null,
  cohort: RoutingEvidenceCohort
): string[] {
  const missing: string[] = [];
  if (riskLevel === null) missing.push("risk level");
  if (cohort.assuranceProfile === null) missing.push("assurance profile");
  if (cohort.host === "unknown" || cohort.host === "unreported") missing.push("host");
  if (PLACEHOLDER_MODEL_IDS.has(cohort.modelId.trim().toLowerCase())) missing.push("model id");
  if (cohort.modelVersion === null || cohort.modelVersion.trim().length === 0) {
    missing.push("model version");
  }
  if (cohort.projectPreset === "unknown" || cohort.projectPreset === "unreported") {
    missing.push("project preset");
  }
  return missing;
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
  task: {
    id: string;
    taskClass?: TaskClass | null;
    riskLevel?: RiskLevel | null;
    riskFactors?: readonly RiskFactor[] | null;
    assuranceProfile?: AssuranceProfile | null;
  };
  cohort?: Partial<RoutingEvidenceCohort>;
  attempts: TelemetryAttempt[];
  routingState: RoutingState;
  sessionCount: number;
}): RoutingSuggestion {
  const { task, attempts, routingState, sessionCount } = input;
  const taskId = task.id;
  const taskClass = task.taskClass ?? null;
  const riskLevel = task.riskLevel ?? null;
  const riskFactors = task.riskFactors === undefined || task.riskFactors === null
    ? null
    : [...task.riskFactors];
  const assuranceProfile =
    task.assuranceProfile !== undefined
      ? task.assuranceProfile
      : input.cohort?.assuranceProfile ?? null;
  const cohort: RoutingEvidenceCohort = {
    assuranceProfile,
    host: input.cohort?.host ?? "unknown",
    modelId: input.cohort?.modelId ?? CHEAP_TIER,
    modelVersion: input.cohort?.modelVersion ?? null,
    projectPreset: input.cohort?.projectPreset ?? "unknown"
  };

  const evidence = downgradeEvidence(attempts, taskClass, riskLevel, cohort);

  if (assuranceProfile === "critical") {
    return {
      taskId,
      taskClass,
      riskLevel,
      riskFactors,
      suggestedTier: STRONGEST_TIER,
      reason: "critical assurance requires the strongest tier",
      evidence
    };
  }

  // 3. Active quarantine forces strongest tier — quality recovers unconditionally.
  const quarantine = routingState.quarantines.find((entry) => entry.taskClass === taskClass);
  if (quarantine && quarantine.untilSessionCount > sessionCount) {
    return {
      taskId,
      taskClass,
      riskLevel,
      riskFactors,
      suggestedTier: STRONGEST_TIER,
      reason: `quarantined until session ${quarantine.untilSessionCount}`,
      evidence
    };
  }

  if (riskLevel === "high") {
    return {
      taskId,
      taskClass,
      riskLevel,
      riskFactors,
      suggestedTier: STRONGEST_TIER,
      reason: "high risk requires the strongest tier",
      evidence
    };
  }

  const incompleteCohort = incompleteDowngradeCohort(riskLevel, cohort);
  if (taskClass === null) {
    incompleteCohort.unshift("task class");
  }
  if (incompleteCohort.length > 0) {
    return {
      taskId,
      taskClass,
      riskLevel,
      riskFactors,
      suggestedTier: STRONGEST_TIER,
      reason: `incomplete routing cohort: ${incompleteCohort.join(", ")}`,
      evidence
    };
  }

  // 4. Evidence-gated downgrade.
  if (evidence.samples >= DOWNGRADE_MIN_SAMPLES && evidence.lowerConfidenceBound !== null) {
    if (evidence.lowerConfidenceBound >= DOWNGRADE_MIN_WILSON_LOWER_BOUND) {
      return {
        taskId,
        taskClass,
        riskLevel,
        riskFactors,
        suggestedTier: CHEAP_TIER,
        reason: `experimental evidence: ${evidence.samples} samples, ${pct(evidence.lowerConfidenceBound)} Wilson lower bound`,
        evidence
      };
    }
    return {
      taskId,
      taskClass,
      riskLevel,
      riskFactors,
      suggestedTier: STRONGEST_TIER,
      reason: `Wilson lower bound ${pct(evidence.lowerConfidenceBound)} below ${pct(DOWNGRADE_MIN_WILSON_LOWER_BOUND)}`,
      evidence
    };
  }

  return {
    taskId,
    taskClass,
    riskLevel,
    riskFactors,
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
  taskClass: TaskClass | null;
  riskLevel?: RiskLevel | null;
  riskFactors?: readonly RiskFactor[] | null;
  sessionCount: number;
  now: string;
}): RoutingState {
  const {
    state,
    taskId,
    taskClass,
    riskLevel = null,
    riskFactors = null,
    sessionCount,
    now
  } = input;
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
    riskLevel,
    riskFactors: riskFactors === null ? null : [...riskFactors],
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
  const lowerBound = suggestion.evidence.lowerConfidenceBound === null
    ? "n/a"
    : `${Math.round(suggestion.evidence.lowerConfidenceBound * 100)}%`;
  return [
    "BEGIN_VISP_MODEL_ROUTING",
    `task: ${suggestion.taskId}`,
    `suggested_tier: ${suggestion.suggestedTier}`,
    `reason: ${suggestion.reason}`,
    `evidence: samples=${suggestion.evidence.samples} passes=${suggestion.evidence.passes} inconclusive=${suggestion.evidence.inconclusive} pass_rate=${passRate} wilson_lower_bound=${lowerBound}`,
    "END_VISP_MODEL_ROUTING"
  ].join("\n");
}
