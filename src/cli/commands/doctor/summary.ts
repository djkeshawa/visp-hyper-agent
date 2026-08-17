/**
 * Turning a finished check list into the two things a reader wants: the one
 * command to run next, and the human-readable report.
 */

import type { DoctorCheck, DoctorSummary } from "./types.js";
import { isVerdictBearing } from "./verdict.js";

export function nextCommand(checks: readonly DoctorCheck[]): string {
  const firstAction = checks.find((check) => check.status === "fail" && check.recovery);
  if (firstAction?.recovery) {
    return firstAction.recovery;
  }
  // Verdict-bearing warnings first, so the command offered is the one that
  // clears the verdict. Offering an advisory remedy above the finding that
  // made the report inconclusive sends the reader to fix something that was
  // never holding the verdict down.
  const firstBearingWarning = checks.find(
    (check) => check.status === "warn" && check.recovery && isVerdictBearing(check.id)
  );
  if (firstBearingWarning?.recovery) {
    return firstBearingWarning.recovery;
  }
  const firstWarning = checks.find((check) => check.status === "warn" && check.recovery);
  return firstWarning?.recovery ?? "visp work \"<goal>\"";
}

export function formatDoctorSummary(summary: DoctorSummary): string {
  const lines = [
    "VISP_HYPER_DOCTOR",
    // Say which question this answers. `visp-dev doctor` reports on the machine
    // and package compatibility; this reports on the project. They were never
    // in conflict, but neither said so, and a weak-model evaluation reading
    // both called the disagreement "unresolvable without knowing which tool is
    // authoritative".
    "Scope: this project (visp-dev doctor covers the machine and package compatibility)",
    `Project: ${summary.projectPath}`,
    `Version: ${summary.version}`,
    `Overall: ${summary.verdict.toUpperCase()}`,
    ""
  ];

  for (const check of summary.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
    if (check.recovery) {
      lines.push(`  next: ${check.recovery}`);
    }
  }

  lines.push("", `Next command: ${summary.nextCommand}`);
  return lines.join("\n");
}
