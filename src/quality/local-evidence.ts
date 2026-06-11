import { analyzeChangedFiles } from "./diff-analyzer.js";
import { checkScope, collectChangedFiles } from "../governance/scope-guard.js";
import { ProjectValidationRunner } from "./validation-runner.js";

export type LocalEvidence = {
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
}): Promise<LocalEvidence> {
  const findings: string[] = [];
  const warnings: string[] = [];

  // --- Verify ---------------------------------------------------------------
  const runner = new ProjectValidationRunner({
    kitCommands: input.task.validationCommands?.length ? input.task.validationCommands : undefined
  });

  let verifyPassed: boolean;
  const commands = await runner.detect(input.projectPath);
  if (commands.length === 0) {
    verifyPassed = true;
    const note = "no validation commands detected; verify passed vacuously";
    findings.push(note);
    warnings.push(note);
  } else {
    const results = await runner.run(input.projectPath, commands);
    verifyPassed = results.every((result) => result.exitCode === 0);
    for (const result of results) {
      if (result.exitCode !== 0) {
        const snippet = result.output.replace(/\s+/gu, " ").trim().slice(0, 200);
        findings.push(
          `verify failed: ${result.command} (exit ${result.exitCode})${snippet ? ` — ${snippet}` : ""}`
        );
      }
    }
  }

  // --- Review ---------------------------------------------------------------
  let reviewPassed = true;

  const diff = await collectChangedFiles(input.projectPath, { mode: "all" });
  const gitFailed = diff.warnings.length > 0;
  if (gitFailed) {
    warnings.push("git diff could not be read; review scope check was skipped");
  }
  const changedFiles = diff.files;

  if (changedFiles.length === 0 && !gitFailed) {
    findings.push("no changes detected");
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
      reviewPassed = false;
    }
  }

  return { verifyPassed, reviewPassed, findings, warnings };
}
