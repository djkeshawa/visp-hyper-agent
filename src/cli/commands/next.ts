import { Command } from "commander";
import { getActiveSession } from "../../core/session-manager.js";
import { resolveProjectPath } from "./shared.js";

export function nextCommand(): Command {
  return new Command("next")
    .description("Print the next recommended action for the active session.")
    .action(async function (this: Command) {
      const session = await getActiveSession(resolveProjectPath(this));
      if (!session) {
        console.log(
          [
            "BEGIN_VISP_NEXT_ACTION",
            "session_id: none",
            "next: run `visp-hyper start \"<goal>\"`",
            "END_VISP_NEXT_ACTION"
          ].join("\n")
        );
        return;
      }
      console.log(
        [
          "BEGIN_VISP_NEXT_ACTION",
          `session_id: ${session.id}`,
          `phase: ${session.phase}`,
          `goal: ${session.goal}`,
          "next: read .visp/hyper/current/agent-instructions.md and continue the implementation workflow",
          "END_VISP_NEXT_ACTION"
        ].join("\n")
      );
    });
}
