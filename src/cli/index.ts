import { Command, CommanderError, Option } from "commander";
import { packageVersion } from "../core/package-version.js";
import { checkpointCommand } from "./commands/checkpoint.js";
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

export type CliIo = {
  writeOut: (chunk: string) => void;
  writeErr: (chunk: string) => void;
};

export type CliRunResult = {
  exitCode: number;
  commanderError?: {
    code: string;
    message: string;
  };
};

const PROCESS_IO: CliIo = {
  writeOut: (chunk) => process.stdout.write(chunk),
  writeErr: (chunk) => process.stderr.write(chunk)
};

function configureEmbeddedCommand(command: Command, io: CliIo): void {
  command.configureOutput(io).exitOverride();
  for (const child of command.commands) {
    configureEmbeddedCommand(child, io);
  }
}

function currentExitCode(): number {
  if (process.exitCode === undefined || process.exitCode === null) {
    return 0;
  }
  const numeric = Number(process.exitCode);
  return Number.isInteger(numeric) ? numeric : 1;
}

/**
 * Run one CLI invocation without allowing Commander to terminate the process.
 * Action handlers may still set `process.exitCode`; callers decide how to
 * isolate or apply that status.
 */
export async function runCliCommand(
  argv: string[],
  io: CliIo = PROCESS_IO
): Promise<CliRunResult> {
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
  program.addCommand(guardCommand());
  program.addCommand(hooksCommand());
  program.addCommand(reviewCommand());
  program.addCommand(rememberCommand());
  program.addCommand(reportCommand());
  program.addCommand(serveCommand());

  // Prepared commands added with addCommand() do not inherit these settings,
  // and hooks contains another command level, so configure the complete tree.
  configureEmbeddedCommand(program, io);

  try {
    await program.parseAsync(argv);
  } catch (caught) {
    if (!(caught instanceof CommanderError)) {
      throw caught;
    }
    return {
      exitCode: caught.exitCode,
      commanderError: {
        code: caught.code,
        message: caught.message
      }
    };
  }

  return { exitCode: currentExitCode() };
}

/** Compatibility entry point used by existing in-process callers and tests. */
export async function runCli(argv: string[]): Promise<void> {
  const result = await runCliCommand(argv);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}
