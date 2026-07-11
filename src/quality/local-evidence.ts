import { analyzeChangedFiles } from "./diff-analyzer.js";
import { checkScope, collectChangedFiles, collectTrackedChangedFiles } from "../governance/scope-guard.js";
import { ProjectValidationRunner } from "./validation-runner.js";
import type { AssuranceLevel, EvidenceVerdict } from "../core/types.js";

export type LocalEvidence = {
  verifyVerdict: EvidenceVerdict;
  reviewVerdict: EvidenceVerdict;
  verdict: EvidenceVerdict;
  assuranceLevel: AssuranceLevel;
  verifyPassed: boolean;
  reviewPassed: boolean;
  findings: string[]; // human-readable lines for the checkpoint block
  warnings: string[];
};

/**
 * Collect mechanically-honest checkpoint evidence without any external kit:
 * verify runs the project's detected (or task-declared) validation commands,
 * review combines the deterministic diff analyzer with a scope check against
 * the task's allowed files and the configured blocked paths. Never throws —
 * git or runner failures degrade to warnings so a non-git or no-script project
 * still produces a usable result.
 */
export async function collectLocalEvidence(input: {
  projectPath: string;
  task: { id: string; allowedFiles?: string[]; validationCommands?: string[] };
  blockedPaths: string[];
  configValidationCommands?: string[];
}): Promise<LocalEvidence> {
  const findings: string[] = [];
  const warnings: string[] = [];

  // --- Verify ---------------------------------------------------------------
  const runner = new ProjectValidationRunner({
    kitCommands: input.task.validationCommands?.length ? input.task.validationCommands : undefined,
    configCommands: input.configValidationCommands
  });

  let verifyVerdict: EvidenceVerdict;
  const commands = await runner.detect(input.projectPath);
  if (commands.length === 0) {
    verifyVerdict = "inconclusive";
    const note = "no validation commands detected; verification is inconclusive";
    findings.push(note);
    warnings.push(note);
  } else {
    const results = await runner.run(input.projectPath, commands);
    // Fail closed: a passing verify requires every command to have exited 0. A
    // null exit (command could not be spawned) is neither a pass nor a genuine
    // "verify failed" — it is reported distinctly but still blocks the gate.
    verifyVerdict = results.some((result) => result.exitCode === null)
      ? "inconclusive"
      : results.every((result) => result.exitCode === 0)
        ? "passed"
        : "failed";
    for (const result of results) {
      if (result.exitCode === 0) {
        continue;
      }
      const snippet = result.output.replace(/\s+/gu, " ").trim().slice(0, 200);
      if (result.exitCode === null) {
        const reason = result.spawnError ?? snippet;
        findings.push(
          `verify inconclusive: ${result.command} could not be run${reason ? ` — ${reason}` : ""}`
        );
        warnings.push(`command could not be run: ${result.command}`);
        continue;
      }
      findings.push(
        `verify failed: ${result.command} (exit ${result.exitCode})${snippet ? ` — ${snippet}` : ""}`
      );
    }
  }

  // --- Review ---------------------------------------------------------------
  let reviewVerdict: EvidenceVerdict = "passed";

  const diff = await collectChangedFiles(input.projectPath, { mode: "all" });
  const gitFailed = diff.warnings.length > 0;
  if (gitFailed) {
    warnings.push("git diff could not be read; review scope check was skipped");
    reviewVerdict = "inconclusive";
  }
  // `.visp/` is visp-hyper's own managed output tree (handoff, state, context
  // packs, telemetry). It is regenerated every run and is never user-authored
  // source, so — like node_modules/dist — it must not count as a scope
  // violation. Filter it before the scope check on all platforms.
  const trackedChanges = await collectTrackedChangedFiles(input.projectPath);
  if (trackedChanges === null) {
    reviewVerdict = "inconclusive";
    warnings.push("tracked Git scope could not be read; canonical artifact review is inconclusive");
  }
  const changedFiles = diff.files.filter((file) =>
    !isVispOwned(file) && (!isCanonicalVisp(file) || trackedChanges?.has(file) === true)
  );

  if (changedFiles.length === 0 && !gitFailed) {
    findings.push("no changes detected");
    if ([...(input.task.allowedFiles ?? [])].some((file) => !isVispOwned(file))) {
      findings.push("review inconclusive: task declares source scope but no source patch was detected");
      reviewVerdict = "inconclusive";
    }
  }

  if (changedFiles.length > 0) {
    // Surface the deterministic diff-analyzer warnings as informational findings.
    const analysis = analyzeChangedFiles({
      changedFiles,
      relevantFiles: [],
      blockedPaths: input.blockedPaths
    });
    for (const warning of analysis.warnings) {
      findings.push(warning);
    }

    // Scope check: blocked paths and allowed-files containment are hard failures.
    const violations = checkScope(changedFiles, {
      allowedFiles: input.task.allowedFiles,
      blockedPaths: input.blockedPaths
    });
    for (const violation of violations) {
      findings.push(
        violation.rule === "blocked-path"
          ? `scope violation: ${violation.file} is a blocked path`
          : `scope violation: ${violation.file} outside allowed files`
      );
      reviewVerdict = "failed";
    }
  }

  const verdict: EvidenceVerdict = verifyVerdict === "failed" || reviewVerdict === "failed"
    ? "failed"
    : verifyVerdict === "inconclusive" || reviewVerdict === "inconclusive"
      ? "inconclusive"
      : "passed";
  return {
    verifyVerdict,
    reviewVerdict,
    verdict,
    assuranceLevel: "local_checked",
    verifyPassed: verifyVerdict === "passed",
    reviewPassed: reviewVerdict === "passed",
    findings,
    warnings
  };
}

/**
 * True for paths inside visp-hyper's own `.visp/` output tree, tolerant of both
 * separators so Windows backslash paths are matched too.
 */
function isVispOwned(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  // Exclude only Hyper's generated runtime. Canonical Kit policy/spec/task
  // artifacts remain visible to scope review and cannot be silently tampered.
  return normalized === ".visp/hyper" || normalized.startsWith(".visp/hyper/");
}

function isCanonicalVisp(file: string): boolean {
  const normalized = file.replace(/\\/gu, "/");
  return normalized === ".visp" || normalized.startsWith(".visp/");
}
