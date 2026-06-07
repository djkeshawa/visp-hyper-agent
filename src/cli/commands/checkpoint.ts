import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { vispPath, writeText } from "../../core/fs-utils.js";
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
      const { stdout } = await execFileAsync("git", ["diff", "--stat"], { cwd: projectPath });
      const content = [
        `# Checkpoint ${new Date().toISOString()}`,
        "",
        `Session: ${session.id}`,
        `Goal: ${session.goal}`,
        "",
        "## Git Diff Stat",
        "",
        stdout.trim() || "_No unstaged diff._",
        ""
      ].join("\n");
      await writeText(vispPath(projectPath, "hyper", "current", "checkpoints.md"), content);
      console.log("Checkpoint written to .visp/hyper/current/checkpoints.md");
    });
}
