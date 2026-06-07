import { Command } from "commander";
import { getActiveSession } from "../../core/session-manager.js";
import { resolveProjectPath } from "./shared.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("Show the active Visp Hyper session status.")
    .action(async function (this: Command) {
      const session = await getActiveSession(resolveProjectPath(this));
      if (!session) {
        console.log("No active Visp Hyper session.");
        return;
      }
      console.log(`Session: ${session.id}`);
      console.log(`Goal: ${session.goal}`);
      console.log(`Tool: ${session.tool}`);
      console.log(`Phase: ${session.phase}`);
      console.log(`Relevant files: ${session.relevantFiles.length}`);
    });
}
