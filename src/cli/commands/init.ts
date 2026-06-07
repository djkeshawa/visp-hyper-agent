import { Command } from "commander";
import { resolveProjectPath } from "./shared.js";
import { initializeProject } from "../../core/session-manager.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Create local Visp Hyper configuration and state files.")
    .option("--force", "Overwrite existing generated config and state.")
    .action(async function (this: Command, options) {
      const projectPath = resolveProjectPath(this);
      await initializeProject(projectPath, Boolean(options.force));
      console.log(`Initialized Visp Hyper at ${projectPath}`);
    });
}
