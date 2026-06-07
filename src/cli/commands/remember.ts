import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { readTextIfExists } from "../../core/fs-utils.js";
import { getActiveSession, updateActiveSession } from "../../core/session-manager.js";
import { writeSessionMemory } from "../../memory/file-memory-provider.js";
import { resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

export function rememberCommand(): Command {
  return new Command("remember")
    .description("Write a local memory summary for the active session.")
    .option("--summary <summary>", "Session summary to store.", "Session completed. Review generated artifacts for details.")
    .option("--decision <decision...>", "Decision to include in memory.")
    .option("--follow-up <followUp...>", "Follow-up to include in memory.")
    .action(async function (this: Command, options: { summary: string; decision?: string[]; followUp?: string[] }) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }
      const reviewSummary = await readTextIfExists(join(projectPath, ".visp", "hyper", "current", "review-report.md"));
      const path = await writeSessionMemory({
        projectPath,
        sessionId: session.id,
        goal: session.goal,
        summary: options.summary,
        changedFiles: await changedFiles(projectPath),
        reviewSummary: reviewSummary ? summarizeReview(reviewSummary) : undefined,
        decisions: options.decision,
        followUps: options.followUp
      });
      await updateActiveSession(projectPath, (current) => ({ ...current, phase: "remembered" }));
      console.log(`Memory written to ${path}`);
    });
}

async function changedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only"], { cwd: projectPath });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeReview(report: string): string {
  return report.split("\n").slice(0, 20).join("\n").trim();
}
