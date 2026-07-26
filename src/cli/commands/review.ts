import { Command } from "commander";
import { readConfig, getActiveSession, updateActiveSession } from "../../core/session-manager.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../kit/workflow-action-renderer.js";
import { analyzeDiff, renderReviewReport } from "../../quality/diff-analyzer.js";
import { resolveProjectPath } from "./shared.js";

export function reviewCommand(): Command {
  return new Command("review")
    .description("Show Kit's canonical action, or run local deterministic review in a Kit-less project.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: kit.reasonCode,
            reason: kit.reason
          })
        );
        process.exitCode = 1;
        return;
      }
      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const diagnostic = await bridge.nextCanonicalActionDiagnostic("auto");
        if (!diagnostic.ok) {
          for (const warning of bridge.warnings) console.warn(`warning: ${warning}`);
          console.log(
            renderKitAuthorityStop({
              status: "INCONCLUSIVE",
              reasonCode: diagnostic.reasonCode,
              reason: diagnostic.reason
            })
          );
          process.exitCode = 1;
          return;
        }
        console.log(renderHyperActionFrame(toHyperActionEnvelope(diagnostic.value)));
        if (diagnostic.value.verdict !== "ready") {
          process.exitCode = 1;
        }
        return;
      }
      const session = await getActiveSession(projectPath);
      if (!session) {
        // Degrade, never crash: match guard/resume rather than throwing.
        console.log(
          [
            "BEGIN_VISP_REVIEW_RESULT",
            "authority: local",
            "assurance: local_checked",
            "status: unavailable",
            "reason: No active Visp Hyper session. Run `visp-hyper start` first.",
            "END_VISP_REVIEW_RESULT"
          ].join("\n")
        );
        process.exitCode = 1;
        return;
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
          "authority: local",
          "assurance: local_checked",
          `changed_files: ${result.changedFiles.length}`,
          `blocked_files: ${result.blockedFiles.length}`,
          `outside_relevant_files: ${result.outsideRelevantFiles.length}`,
          `dependency_files: ${result.dependencyFiles.length}`,
          `public_api_files: ${result.publicApiFiles.length}`,
          `has_test_changes: ${result.hasTestChanges}`,
          `warnings: ${result.warnings.length}`,
          ...result.warnings.map((warning) => `warning: ${warning}`),
          // Emitted only when git could not answer, so an ordinary local review
          // block stays byte-identical to what existing consumers already parse.
          ...(result.diffAvailable
            ? []
            : ["status: inconclusive", "reason_code: changed_files_unavailable"]),
          "report: .visp/hyper/current/review-report.md",
          "END_VISP_REVIEW_RESULT"
        ].join("\n")
      );
      if (!result.diffAvailable) {
        // Fail closed: an unreadable diff is never a clean review.
        process.exitCode = 1;
      }
    });
}
