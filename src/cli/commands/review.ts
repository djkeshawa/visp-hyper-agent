import { Command } from "commander";
import { readConfig, getActiveSession, updateActiveSession } from "../../core/session-manager.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { analyzeDiff, renderReviewReport } from "../../quality/diff-analyzer.js";
import { resolveProjectPath } from "./shared.js";

export function reviewCommand(): Command {
  return new Command("review")
    .description("Analyze the current diff against deterministic quality gates.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }
      const config = await readConfig(projectPath);
      const result = await analyzeDiff({
        projectPath,
        relevantFiles: session.relevantFiles,
        blockedPaths: config.blockedPaths
      });
      await writeText(vispPath(projectPath, "hyper", "current", "review-report.md"), renderReviewReport(result));
      await updateActiveSession(projectPath, (current) => ({ ...current, phase: "review" }));
      console.log(
        [
          "BEGIN_VISP_REVIEW_RESULT",
          `changed_files: ${result.changedFiles.length}`,
          `blocked_files: ${result.blockedFiles.length}`,
          `outside_relevant_files: ${result.outsideRelevantFiles.length}`,
          `dependency_files: ${result.dependencyFiles.length}`,
          `public_api_files: ${result.publicApiFiles.length}`,
          `has_test_changes: ${result.hasTestChanges}`,
          `warnings: ${result.warnings.length}`,
          ...result.warnings.map((warning) => `warning: ${warning}`),
          "report: .visp/hyper/current/review-report.md",
          "END_VISP_REVIEW_RESULT"
        ].join("\n")
      );
    });
}
