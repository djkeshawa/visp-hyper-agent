import { Command, Option } from "commander";
import { packageVersion } from "../core/package-version.js";
import { checkpointCommand } from "./commands/checkpoint.js";
import { challengeCommand } from "./commands/challenge.js";
import { cockpitCommand } from "./commands/cockpit.js";
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
import {
  checkVerbCommand,
  handoffVerbCommand,
  learnVerbCommand,
  newVerbCommand,
  planVerbCommand,
  recallVerbCommand,
  setupVerbCommand
} from "./commands/verbs.js";

// P10-US-05 (D-106): the thirteen-verb surface. `visp <verb>` for a human,
// `visp_<verb>` over MCP for a model — one vocabulary. The dispatcher decides
// nothing: every verb routes to Kit through the bridge or to existing Hyper
// machinery. Legacy commands stay registered but hidden so installed hooks,
// MCP argv mappings and older instructions keep working through the window.
export const THIRTEEN_VERBS = Object.freeze([
  "setup",
  "doctor",
  "new",
  "plan",
  "next",
  "work",
  "check",
  "save",
  "handoff",
  "status",
  "recall",
  "learn",
  "cockpit"
] as const);

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name("visp")
    .description("Visp: one workflow surface. Kit decides; this coordinator presents.")
    .version(packageVersion())
    .showHelpAfterError()
    .helpOption("-h, --help", "Display help for command.");

  program.addOption(new Option("--project <path>", "Target project path.").default(process.cwd()));

  // The thirteen verbs, in the D-106 order.
  program.addCommand(setupVerbCommand());
  program.addCommand(doctorCommand());
  program.addCommand(newVerbCommand());
  program.addCommand(planVerbCommand());
  program.addCommand(nextCommand());
  program.addCommand(runCommand().name("work").description("Drive the coding tool through the prepared task."));
  program.addCommand(checkVerbCommand());
  program.addCommand(checkpointCommand().name("save").description("Record a checkpoint of the current work."));
  program.addCommand(handoffVerbCommand());
  program.addCommand(statusCommand());
  program.addCommand(recallVerbCommand());
  program.addCommand(learnVerbCommand());
  program.addCommand(cockpitCommand());

  // Legacy surface: hidden, still runnable (installed hooks and MCP mappings
  // reference these). Removal is a post-proof decision, not this release.
  program.addCommand(initCommand(), { hidden: true });
  program.addCommand(startCommand(), { hidden: true });
  program.addCommand(runCommand(), { hidden: true });
  program.addCommand(quickCommand(), { hidden: true });
  program.addCommand(resumeCommand(), { hidden: true });
  program.addCommand(checkpointCommand(), { hidden: true });
  program.addCommand(challengeCommand(), { hidden: true });
  program.addCommand(guardCommand(), { hidden: true });
  program.addCommand(hooksCommand(), { hidden: true });
  program.addCommand(reviewCommand(), { hidden: true });
  program.addCommand(rememberCommand(), { hidden: true });
  program.addCommand(reportCommand(), { hidden: true });
  program.addCommand(serveCommand(), { hidden: true });

  await program.parseAsync(argv);
}
