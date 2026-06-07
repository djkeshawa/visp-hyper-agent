import { Command } from "commander";
import { getActiveSession, updateActiveSession } from "../../core/session-manager.js";
import { writeSessionMemory } from "../../memory/file-memory-provider.js";
import { resolveProjectPath } from "./shared.js";

export function rememberCommand(): Command {
  return new Command("remember")
    .description("Write a local memory summary for the active session.")
    .option("--summary <summary>", "Session summary to store.", "Session completed. Review generated artifacts for details.")
    .action(async function (this: Command, options: { summary: string }) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }
      const path = await writeSessionMemory({
        projectPath,
        sessionId: session.id,
        goal: session.goal,
        summary: options.summary
      });
      await updateActiveSession(projectPath, (current) => ({ ...current, phase: "remembered" }));
      console.log(`Memory written to ${path}`);
    });
}
