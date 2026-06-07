import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { getActiveSession } from "../../core/session-manager.js";
import { resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

export function checkpointCommand(): Command {
  return new Command("checkpoint")
    .description("Capture current progress and git diff summary.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }
      const [{ stdout: stat }, { stdout: names }] = await Promise.all([
        execFileAsync("git", ["diff", "--stat", "HEAD"], { cwd: projectPath }),
        execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: projectPath })
      ]);
      const content = [
        `## Checkpoint ${new Date().toISOString()}`,
        "",
        `Session: ${session.id}`,
        `Goal: ${session.goal}`,
        "",
        "## Git Diff Stat",
        "",
        stat.trim() || "_No diff._",
        "",
        "## Changed Files",
        "",
        ...(names.trim() ? names.trim().split("\n").map((file) => `- ${file}`) : ["_No changed files._"]),
        ""
      ].join("\n");
      const path = vispPath(projectPath, "hyper", "current", "checkpoints.md");
      const previous = await readTextIfExists(path);
      await writeText(path, previous ? `${previous.trimEnd()}\n\n${content}` : `# Checkpoints\n\n${content}`);
      console.log("Checkpoint written to .visp/hyper/current/checkpoints.md");
    });
}
