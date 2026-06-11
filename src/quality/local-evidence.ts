import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyzeChangedFiles } from "./diff-analyzer.js";
import { isBlockedPath } from "../governance/blocked-files.js";
import { ProjectValidationRunner } from "./validation-runner.js";

const execFileAsync = promisify(execFile);

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
  let changedFiles: string[] = [];

  const diff = await changedFilesFromGit(input.projectPath);
  if (diff.failed) {
    warnings.push("git diff could not be read; review scope check was skipped");
  } else {
    changedFiles = diff.files;
  }

  if (changedFiles.length === 0 && !diff.failed) {
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
    const allowed = input.task.allowedFiles;
    const hasAllowList = Array.isArray(allowed) && allowed.length > 0;
    for (const file of changedFiles) {
      if (isBlockedPath(file, input.blockedPaths)) {
        findings.push(`scope violation: ${file} is a blocked path`);
        reviewPassed = false;
        continue;
      }
      if (hasAllowList && !matchesAllowed(file, allowed)) {
        findings.push(`scope violation: ${file} outside allowed files`);
        reviewPassed = false;
      }
    }
  }

  return { verifyPassed, reviewPassed, findings, warnings };
}

function matchesAllowed(file: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (entry === file) {
      return true;
    }
    if (entry.endsWith("/")) {
      return file.startsWith(entry);
    }
    return file.startsWith(`${entry}/`);
  });
}

async function changedFilesFromGit(
  projectPath: string
): Promise<{ files: string[]; failed: boolean }> {
  try {
    const [unstaged, staged] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only"], { cwd: projectPath }),
      execFileAsync("git", ["diff", "--name-only", "--cached"], { cwd: projectPath })
    ]);
    const files = [...splitNames(unstaged.stdout), ...splitNames(staged.stdout)];
    return { files: [...new Set(files)], failed: false };
  } catch {
    return { files: [], failed: true };
  }
}

function splitNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
