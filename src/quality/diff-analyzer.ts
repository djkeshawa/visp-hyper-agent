import { gitLines, gitOutput } from "../core/git.js";
import { isBlockedPath } from "../governance/blocked-files.js";

export type ReviewResult = {
  changedFiles: string[];
  blockedFiles: string[];
  outsideRelevantFiles: string[];
  dependencyFiles: string[];
  publicApiFiles: string[];
  hasTestChanges: boolean;
  warnings: string[];
  /**
   * False when git could not report the diff at all (not a repository, no
   * commits yet, unreadable index). An empty `changedFiles` then means "we do
   * not know", NOT "nothing changed" — callers must degrade to inconclusive
   * rather than reporting a clean review.
   */
  diffAvailable: boolean;
};

/**
 * Read the working tree's diff against HEAD and analyze it. Never throws: a
 * project with no commits yet has no resolvable `HEAD`, which is an ordinary
 * state and must not take down the command.
 */
export async function analyzeDiff(input: {
  projectPath: string;
  relevantFiles: string[];
  blockedPaths: string[];
}): Promise<ReviewResult> {
  const diff = await gitOutput(input.projectPath, ["diff", "--name-only", "HEAD"]);
  if (!diff.ok) {
    const unavailable = analyzeChangedFiles({ ...input, changedFiles: [] });
    return {
      ...unavailable,
      diffAvailable: false,
      warnings: [`Changed files could not be read; review is inconclusive (${diff.reason}).`]
    };
  }
  return analyzeChangedFiles({ ...input, changedFiles: gitLines(diff.stdout) });
}

export function analyzeChangedFiles(input: {
  changedFiles: string[];
  relevantFiles: string[];
  blockedPaths: string[];
}): ReviewResult {
  const relevant = new Set(input.relevantFiles);
  const result: ReviewResult = {
    changedFiles: input.changedFiles,
    blockedFiles: input.changedFiles.filter((file) => isBlockedPath(file, input.blockedPaths)),
    outsideRelevantFiles: input.changedFiles.filter((file) => relevant.size > 0 && !relevant.has(file)),
    dependencyFiles: input.changedFiles.filter(isDependencyFile),
    publicApiFiles: input.changedFiles.filter(isPublicApiFile),
    hasTestChanges: input.changedFiles.some(isTestFile),
    warnings: [],
    diffAvailable: true
  };
  result.warnings = warningsFor(result);
  return result;
}

export function renderReviewReport(result: ReviewResult): string {
  return [
    "# Review Report",
    "",
    `Changed files: ${result.changedFiles.length}`,
    `Warnings: ${result.warnings.length}`,
    `Blocked files: ${result.blockedFiles.length}`,
    `Outside relevant files: ${result.outsideRelevantFiles.length}`,
    `Dependency files: ${result.dependencyFiles.length}`,
    `Public API files: ${result.publicApiFiles.length}`,
    `Has test changes: ${result.hasTestChanges}`,
    "",
    "## Changed Files",
    "",
    ...(result.changedFiles.length > 0 ? result.changedFiles.map((file) => `- ${file}`) : ["_No unstaged changes._"]),
    "",
    "## Warnings",
    "",
    ...(result.warnings.length > 0 ? result.warnings.map((warning) => `- ${warning}`) : ["_No deterministic warnings._"]),
    ""
  ].join("\n");
}

function warningsFor(result: Omit<ReviewResult, "warnings">): string[] {
  const warnings = [];
  if (result.blockedFiles.length > 0) {
    warnings.push(`Blocked files changed: ${result.blockedFiles.join(", ")}`);
  }
  if (result.outsideRelevantFiles.length > 0) {
    warnings.push(`Files outside selected context changed: ${result.outsideRelevantFiles.join(", ")}`);
  }
  if (result.dependencyFiles.length > 0) {
    warnings.push(`Dependency manifests or lockfiles changed: ${result.dependencyFiles.join(", ")}`);
  }
  if (result.publicApiFiles.length > 0) {
    warnings.push(`Likely public API files changed: ${result.publicApiFiles.join(", ")}`);
  }
  if (result.changedFiles.length > 0 && !result.hasTestChanges) {
    warnings.push("No test changes detected for this diff.");
  }
  return warnings;
}

function isDependencyFile(file: string): boolean {
  return /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/u.test(file);
}

function isPublicApiFile(file: string): boolean {
  return file === "src/index.ts" || file.endsWith(".d.ts") || file === "src/core/types.ts";
}

function isTestFile(file: string): boolean {
  return /(^tests\/|\.test\.|\.spec\.)/u.test(file);
}
