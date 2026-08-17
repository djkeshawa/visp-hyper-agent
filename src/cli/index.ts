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
// machinery. Legacy commands stay registered outside that list so installed
// hooks, MCP argv mappings and older instructions keep working through the
// window — kept out of the thirteen, but no longer kept out of `--help`; see
// `additionalCommandsHelp`.
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

/**
 * Every command this binary registers, rendered from the registry itself.
 *
 * `visp --help` listed the thirteen verbs and nothing else, while `init`,
 * `hooks`, `guard`, `serve`, `review` and the legacy names below it all ran.
 * That is not a tidier help text, it is an incomplete one: `doctor` tells users
 * to run `visp hooks git`, and `visp init --memory-mode` and `--with-hooks` are
 * the documented repairs for a disabled memory bridge and for unenforced task
 * scopes — none of which a reader of `--help`, human or agent, could see.
 *
 * Generated rather than written out, because a hand-kept list is what drifted:
 * these entries appear the moment a command is registered, and a command
 * removed from the registry disappears from here with it.
 */
function additionalCommandsHelp(program: Command): string {
  const help = program.createHelp();
  const listed = new Set(help.visibleCommands(program).map((command) => command.name()));
  const rest = program.commands.filter((command) => !listed.has(command.name()));
  if (rest.length === 0) return "";

  // Laid out the way Commander lays out its own Commands list, so this reads as
  // part of the same help rather than beside it: a name column, then the
  // description wrapped with continuation lines hanging under it, then every
  // line indented. `wrap` takes the WHOLE line and the column to hang at —
  // handing it the description alone silently splits the text at that column
  // instead, which lines up by coincidence and wraps at the wrong width.
  const ITEM_INDENT = 2;
  const SEPARATOR = 2;
  const nameColumn = Math.max(...rest.map((command) => command.name().length)) + SEPARATOR;
  const helpWidth = process.stdout.columns ?? 80;

  return [
    "",
    "Additional commands (supported, outside the thirteen-verb surface; some are",
    "legacy names kept so installed hooks and older instructions keep working):",
    ...rest.map((command) =>
      help
        .wrap(
          `${command.name().padEnd(nameColumn)}${command.description()}`,
          helpWidth - ITEM_INDENT,
          nameColumn
        )
        .replace(/^/gmu, " ".repeat(ITEM_INDENT))
    )
  ].join("\n");
}

/**
 * The configured root command. Exported so a test can read the registry and the
 * rendered help from the same object the binary runs.
 */
export function buildProgram(): Command {
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

  program.addHelpText("after", () => additionalCommandsHelp(program));

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
