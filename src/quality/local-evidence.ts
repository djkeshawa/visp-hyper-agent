import { analyzeChangedFiles } from "./diff-analyzer.js";
import {
  attributableChangedFiles,
  checkScope,
  collectChangedFiles,
  type GitEvidenceInventory
} from "../governance/scope-guard.js";
import { ProjectValidationRunner } from "./validation-runner.js";
import type { AssuranceLevel, EvidenceVerdict, GitBaseline } from "../core/types.js";

export type LocalEvidence = {
  verifyVerdict: EvidenceVerdict;
  reviewVerdict: EvidenceVerdict;
  verdict: EvidenceVerdict;
  assuranceLevel: AssuranceLevel;
  verifyPassed: boolean;
  reviewPassed: boolean;
  findings: string[]; // human-readable lines for the checkpoint block
  warnings: string[];
  gitEvidence: GitEvidenceInventory;
  changedFiles: string[];
};

/**
 * Collect mechanically-honest checkpoint evidence without any external kit:
 * verify runs the project's detected (or task-declared) validation commands,
 * review combines the deterministic diff analyzer with a scope check against
 * the task's allowed files and the configured blocked paths. Never throws —
 * Git failures produce inconclusive evidence and can never authorize progress.
 */
export async function collectLocalEvidence(input: {
  projectPath: string;
  task: { id: string; allowedFiles?: string[]; validationCommands?: string[] };
  blockedPaths: string[];
  configValidationCommands?: string[];
  baseline: GitBaseline;
  allowEmpty?: boolean;
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

  // Collect after validation: validation commands are allowed to generate or
  // modify files, and those effects must be reviewed by the same checkpoint.
  const diff = await collectChangedFiles(input.projectPath, {
    mode: "baseline",
    baseline: input.baseline
  });
  const gitFailed = !diff.ok;
  if (gitFailed) {
    warnings.push(...diff.warnings);
    findings.push(
      `review inconclusive: complete Git evidence is unavailable${
        diff.warnings.length > 0 ? ` — ${diff.warnings.join("; ")}` : ""
      }`
    );
    reviewVerdict = "inconclusive";
  }

  // Hyper's runtime files are created by the evidence command itself. Every
  // other nonignored file, including canonical `.visp` files, remains in scope.
  const changedFiles = attributableChangedFiles(diff.files);

  if (changedFiles.length === 0 && !gitFailed) {
    if (input.allowEmpty) {
      findings.push("no attributable changes detected (explicitly allowed)");
    } else {
      findings.push("review failed: no attributable changes detected; use --allow-empty only when intentional");
      reviewVerdict = "failed";
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
    warnings,
    gitEvidence: diff,
    changedFiles
  };
}

export { attributableChangedFiles } from "../governance/scope-guard.js";
