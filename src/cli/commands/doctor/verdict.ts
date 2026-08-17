/**
 * Which findings the `Overall:` line answers for, and which it does not.
 *
 * `visp doctor` printed `Overall: PASS` above a WARN reading "Hyper ran 2
 * work-driving verbs in this project and recorded NO session … whatever was
 * built here was not coordinated by Hyper" (LC-97). Both sentences described
 * the same run, and a reader — or an orchestrator — taking the top line got
 * the opposite of what the report said underneath. The defect was not in that
 * check. It was that `Overall` summed failures only, so no warning could reach
 * it, whatever the warning said.
 *
 * THE RULE, stated once here rather than decided per check:
 *
 *   A finding is VERDICT-BEARING when it means this report is not a sound
 *   account of this project — the record Hyper keeps of it, the identity of
 *   the build doing the reporting, the trusted configuration everything else
 *   is read through, or the Kit binding the Kit findings arrived over. Degrade
 *   any of those and the rest of the report is being read through something
 *   Doctor cannot vouch for.
 *
 *   A finding is ADVISORY when it means this project has LESS CAPABILITY than
 *   it could — an optional subsystem absent, switched off, or deliberately not
 *   installed. The report is still true; the project simply does less. Kit-less
 *   mode, file memory, no intel provider, no host binary and an uninstalled git
 *   hook are all supported configurations, and saying so must not cost the
 *   verdict.
 *
 * An unclassified id is verdict-bearing, not advisory. A check added later
 * without a decision costs the verdict rather than passing silently — the same
 * fail-closed rule the strict contracts follow. That includes the bridge
 * warnings, whose ids are generated: they carry whatever Kit said, so nothing
 * here can classify them in advance.
 */

import type { DoctorCheck, DoctorVerdict } from "./types.js";

/**
 * Checks whose WARN narrows what this project can do without contradicting
 * what Doctor reports. Each entry is a capability that is optional by design.
 */
const ADVISORY_CHECKS: ReadonlySet<string> = new Set([
  // Kit-less operation is a supported mode (assurance is labelled `advisory`
  // or `local_checked`); a project without Kit artifacts is configured, not ill.
  "kit-artifacts",
  // Enforcement surfaces. Their absence removes a guard rail and is worth
  // saying; it does not make the report untrue.
  "git-hook",
  // Hosts document sequential and Git/CI fallbacks, so a missing binary or
  // stale assets narrow the surface rather than falsify it.
  "selected-host",
  "tool-assets",
  // Memory is optional (D-118). This is the LC-93 warning: file mode with a
  // store present is a real contradiction to report, and it is a contradiction
  // about a capability, not about the account Doctor is giving.
  "memory",
  // Intel is optional and descriptive; a project may run the workflow without
  // the navigation lane.
  "intel-mcp",
  // Kit's gate blocking, and Kit having no active task yet, are ordinary
  // workflow states reported by the authority itself.
  "kit-next-gate",
  "kit-context-pack",
  // Both of this check's warnings describe what the INSTALLED PAIR can do: an
  // older Kit that does not advertise provenance freshness, or one whose
  // contract cannot be read at all. The first is a capability an older pair
  // legitimately lacks. The second would undermine everything read after it —
  // and it is already reported as a hard fail on `kit-workflow-action`, which
  // takes the verdict to FAIL on its own, so nothing is lost by reading this
  // one as advisory.
  "kit-contract"
]);

export function isVerdictBearing(checkId: string): boolean {
  return !ADVISORY_CHECKS.has(checkId);
}

/**
 * FAIL when something is broken, INCONCLUSIVE when Doctor cannot vouch for its
 * own account, PASS only when neither is true.
 *
 * INCONCLUSIVE exists because the two states it separates are genuinely
 * different: nothing here is broken, and Doctor still cannot certify the
 * project. Folding that into PASS is what LC-97 reports; folding it into FAIL
 * would send people looking for a fault that is not there.
 */
export function doctorVerdict(checks: readonly DoctorCheck[]): DoctorVerdict {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn" && isVerdictBearing(check.id))) {
    return "inconclusive";
  }
  return "pass";
}
