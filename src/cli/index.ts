import { Command, Option } from "commander";
import { packageVersion } from "../core/package-version.js";
import { checkpointCommand } from "./commands/checkpoint.js";
import { challengeCommand } from "./commands/challenge.js";
import { doctorCommand } from "./commands/doctor.js";
import { guardCommand } from "./commands/guard.js";
import { hooksCommand } from "./commands/hooks.js";
import { initCommand } from "./commands/init.js";
import { nextCommand } from "./commands/next.js";
import { quickCommand } from "./commands/quick.js";
import { rememberCommand } from "./commands/remember.js";
import { reportCommand } from "./commands/report.js";
import { resumeCommand } from "./commands/resume.js";
import { reviewCommand } from "./commands/review.js";
import { runCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name("visp-hyper")
    .description("Local-first companion workflow controller for existing AI coding tools.")
    .version(packageVersion())
    .showHelpAfterError()
    .helpOption("-h, --help", "Display help for command.");

  program.addOption(new Option("--project <path>", "Target project path.").default(process.cwd()));
  program.addCommand(initCommand());
  program.addCommand(startCommand());
  program.addCommand(runCommand());
  program.addCommand(quickCommand());
  program.addCommand(nextCommand());
  program.addCommand(resumeCommand());
  program.addCommand(statusCommand());
  program.addCommand(doctorCommand());
  program.addCommand(checkpointCommand());
  program.addCommand(challengeCommand());
  program.addCommand(guardCommand());
  program.addCommand(hooksCommand());
  program.addCommand(reviewCommand());
  program.addCommand(rememberCommand());
  program.addCommand(reportCommand());
  program.addCommand(serveCommand());

  await program.parseAsync(argv);
}
