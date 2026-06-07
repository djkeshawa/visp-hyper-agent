import { Command } from "commander";
import { getActiveSession } from "../../core/session-manager.js";
import { resolveProjectPath } from "./shared.js";

export function nextCommand(): Command {
  return new Command("next")
    .description("Print the next recommended action for the active session.")
    .action(async function (this: Command) {
      const session = await getActiveSession(resolveProjectPath(this));
      if (!session) {
        console.log("BEGIN_VISP_NEXT_ACTION\nnext: run `visp-hyper start \"<goal>\"`\nEND_VISP_NEXT_ACTION");
        return;
      }
      console.log(
        [
          "BEGIN_VISP_NEXT_ACTION",
          `session_id: ${session.id}`,
          "next: read .visp/hyper/current/agent-instructions.md and continue the implementation workflow",
          "END_VISP_NEXT_ACTION"
        ].join("\n")
      );
    });
}
