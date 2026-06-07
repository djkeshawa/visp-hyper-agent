import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isBlockedPath } from "../governance/blocked-files.js";

const execFileAsync = promisify(execFile);

export type ReviewResult = {
  changedFiles: string[];
  blockedFiles: string[];
  outsideRelevantFiles: string[];
  hasTestChanges: boolean;
};

export async function analyzeDiff(input: {
  projectPath: string;
  relevantFiles: string[];
  blockedPaths: string[];
}): Promise<ReviewResult> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only"], { cwd: input.projectPath });
  const changedFiles = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const relevant = new Set(input.relevantFiles);
  return {
    changedFiles,
    blockedFiles: changedFiles.filter((file) => isBlockedPath(file, input.blockedPaths)),
    outsideRelevantFiles: changedFiles.filter((file) => relevant.size > 0 && !relevant.has(file)),
    hasTestChanges: changedFiles.some((file) => /(^tests\/|\.test\.|\.spec\.)/u.test(file))
  };
}

export function renderReviewReport(result: ReviewResult): string {
  const warnings = [];
  if (result.blockedFiles.length > 0) {
    warnings.push(`Blocked files changed: ${result.blockedFiles.join(", ")}`);
  }
  if (result.outsideRelevantFiles.length > 0) {
    warnings.push(`Files outside selected context changed: ${result.outsideRelevantFiles.join(", ")}`);
  }
  if (result.changedFiles.length > 0 && !result.hasTestChanges) {
    warnings.push("No test changes detected for this diff.");
  }

  return [
    "# Review Report",
    "",
    `Changed files: ${result.changedFiles.length}`,
    `Warnings: ${warnings.length}`,
    "",
    "## Changed Files",
    "",
    ...(result.changedFiles.length > 0 ? result.changedFiles.map((file) => `- ${file}`) : ["_No unstaged changes._"]),
    "",
    "## Warnings",
    "",
    ...(warnings.length > 0 ? warnings.map((warning) => `- ${warning}`) : ["_No deterministic warnings._"]),
    ""
  ].join("\n");
}

