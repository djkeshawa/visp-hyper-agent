import type { EvidenceVerdict } from "../core/types.js";
import type {
  KitReconcileSummary,
  KitReviewSummary,
  KitVerifySummary
} from "../kit/kit-schemas.js";

export type KitCheckpointStageVerdict = EvidenceVerdict | "not_run";

export type KitCheckpointEvidence = {
  verifyVerdict: KitCheckpointStageVerdict;
  reviewVerdict: KitCheckpointStageVerdict;
  reconcileVerdict: KitCheckpointStageVerdict;
  verdict: Exclude<EvidenceVerdict, "passed">;
  assuranceLevel: "advisory";
  evidenceSource: "kit";
  reasonCode: string;
  reason: string;
  findings: string[];
};

type KitCheckpointSummary =
  | KitVerifySummary
  | KitReviewSummary
  | KitReconcileSummary;

type StageName = "verify" | "review" | "reconcile";

type StageFact = {
  name: StageName;
  verdict: KitCheckpointStageVerdict;
  issue?: "incoherent" | "unavailable";
  findings: string[];
};

/**
 * Represent a configured Kit authority failure without evaluating local
 * evidence or inventing a strict workflow result.
 */
export function unavailableKitCheckpointEvidence(input: {
  reasonCode: string;
  reason: string;
}): KitCheckpointEvidence {
  return {
    verifyVerdict: "not_run",
    reviewVerdict: "not_run",
    reconcileVerdict: "not_run",
    verdict: "inconclusive",
    assuranceLevel: "advisory",
    evidenceSource: "kit",
    reasonCode: input.reasonCode,
    reason: input.reason,
    findings: unique([input.reason])
  };
}

/**
 * Aggregate Kit-produced checkpoint facts for presentation only.
 *
 * This function deliberately cannot return `passed` or `kit_strict`. Current
 * Kit 2.0 verify/review/reconcile summaries do not contain an authoritative
 * post-checkpoint transition, so even three passing summaries leave Hyper
 * inconclusive and unable to mutate strict workflow state.
 */
export function aggregateKitCheckpointEvidence(input: {
  verify: KitVerifySummary | null;
  review: KitReviewSummary | null;
  reconcile?: KitReconcileSummary | null;
  blockingFindings?: string[];
}): KitCheckpointEvidence {
  const stages = [
    stageFact("verify", input.verify),
    stageFact("review", input.review),
    input.reconcile === undefined
      ? notRunStage("reconcile")
      : stageFact("reconcile", input.reconcile)
  ] as const;
  const blockingFindings = unique(input.blockingFindings ?? []);

  if (blockingFindings.length > 0) {
    return result(stages, {
      verdict: "failed",
      reasonCode: "context_freshness_failed",
      reason: "The adopted Kit context is no longer current.",
      findings: [
        ...stages.flatMap((stage) => stage.findings),
        ...blockingFindings
      ]
    });
  }

  const failed = stages.find((stage) => stage.verdict === "failed");
  if (failed) {
    return result(stages, {
      verdict: "failed",
      reasonCode: `kit_${failed.name}_failed`,
      reason: `Kit ${failed.name} reported failure.`,
      findings: stages.flatMap((stage) => stage.findings)
    });
  }

  const incoherent = stages.find((stage) => stage.issue === "incoherent");
  if (incoherent) {
    return result(stages, {
      verdict: "inconclusive",
      reasonCode: `kit_${incoherent.name}_incoherent`,
      reason: `Kit ${incoherent.name} reported internally contradictory evidence.`,
      findings: stages.flatMap((stage) => stage.findings)
    });
  }

  const unavailable = stages.find(
    (stage) => stage.verdict === "inconclusive" || stage.verdict === "not_run"
  );
  if (unavailable) {
    const suffix = unavailable.verdict === "not_run" ? "not_run" : "unavailable";
    return result(stages, {
      verdict: "inconclusive",
      reasonCode: `kit_${unavailable.name}_${suffix}`,
      reason:
        unavailable.verdict === "not_run"
          ? `Kit ${unavailable.name} did not run.`
          : `Kit ${unavailable.name} evidence was unavailable or unparseable.`,
      findings: stages.flatMap((stage) => stage.findings)
    });
  }

  return result(stages, {
    verdict: "inconclusive",
    reasonCode: "kit_post_checkpoint_transition_unavailable",
    reason:
      "Kit checkpoint summaries passed, but the current contract exposes no authoritative post-checkpoint transition.",
    findings: stages.flatMap((stage) => stage.findings)
  });
}

/** Render one deterministic checkpoint frame with no recovery instruction. */
export function renderKitCheckpointEvidence(input: {
  taskId: string;
  evidence: KitCheckpointEvidence;
  contextFreshness: string;
  warnings?: string[];
}): string {
  const { evidence } = input;
  const lines = [
    "BEGIN_VISP_CHECKPOINT_RESULT",
    `task: ${singleLine(input.taskId)}`,
    `verify: ${renderVerdict(evidence.verifyVerdict)}`,
    `review: ${renderVerdict(evidence.reviewVerdict)}`,
    `reconcile: ${renderVerdict(evidence.reconcileVerdict)}`,
    `verdict: ${evidence.verdict.toUpperCase()}`,
    `assurance_level: ${evidence.assuranceLevel}`,
    `evidence_source: ${evidence.evidenceSource}`,
    `context_freshness: ${singleLine(input.contextFreshness)}`
  ];

  const warnings = unique(input.warnings ?? []);
  if (warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of warnings) {
      lines.push(` - ${singleLine(warning)}`);
    }
  }

  lines.push(`reason_code: ${singleLine(evidence.reasonCode)}`);
  lines.push(`reason: ${singleLine(evidence.reason)}`);
  if (evidence.findings.length > 0) {
    lines.push("findings:");
    for (const finding of evidence.findings) {
      lines.push(` - ${singleLine(finding)}`);
    }
  }
  lines.push(`status: ${evidence.verdict.toUpperCase()}`);
  lines.push("END_VISP_CHECKPOINT_RESULT");
  return lines.join("\n");
}

function stageFact(name: StageName, summary: KitCheckpointSummary | null): StageFact {
  if (summary === null) {
    return {
      name,
      verdict: "inconclusive",
      issue: "unavailable",
      findings: [`${name} evidence was unavailable or unparseable`]
    };
  }
  const errors = summary.errors ?? [];
  const warnings = (summary.warnings ?? []).map(
    (entry) => `${name} warning: ${entry}`
  );
  const findings = (summary.findings ?? []).map(
    (entry) => `${name} finding: ${stringifyFinding(entry)}`
  );
  if (summary.success) {
    if (errors.length > 0) {
      return {
        name,
        verdict: "inconclusive",
        issue: "incoherent",
        findings: unique([
          `${name} reported success=true with errors`,
          ...errors.map((entry) => `${name} error: ${entry}`),
          ...warnings,
          ...findings
        ])
      };
    }
    return { name, verdict: "passed", findings: unique([...warnings, ...findings]) };
  }
  return {
    name,
    verdict: "failed",
    findings: unique([
      `${name} failed`,
      ...errors.map((entry) => `${name} error: ${entry}`),
      ...warnings,
      ...findings
    ])
  };
}

function notRunStage(name: StageName): StageFact {
  return { name, verdict: "not_run", findings: [] };
}

function result(
  stages: readonly [StageFact, StageFact, StageFact],
  input: Pick<KitCheckpointEvidence, "verdict" | "reasonCode" | "reason" | "findings">
): KitCheckpointEvidence {
  return {
    verifyVerdict: stages[0].verdict,
    reviewVerdict: stages[1].verdict,
    reconcileVerdict: stages[2].verdict,
    verdict: input.verdict,
    assuranceLevel: "advisory",
    evidenceSource: "kit",
    reasonCode: input.reasonCode,
    reason: input.reason,
    findings: unique(input.findings)
  };
}

function renderVerdict(verdict: KitCheckpointStageVerdict): string {
  return verdict === "not_run" ? "NOT_RUN" : verdict.toUpperCase();
}

function stringifyFinding(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["title", "message", "description", "summary"]) {
      if (typeof record[key] === "string") {
        return record[key];
      }
    }
  }
  return JSON.stringify(value) ?? String(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(singleLine).filter(Boolean))];
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}
