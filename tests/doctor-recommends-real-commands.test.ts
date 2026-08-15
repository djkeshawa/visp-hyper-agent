// Part D — doctor may only recommend commands that exist.
//
// `visp doctor` is the first command a new user runs. On a real project its
// guidance named four commands, none of which appear in `visp --help`:
//
//     visp-hyper init --tool <tool>
//     visp-hyper hooks git
//     visp init
//     visp agent bootstrap <tool>
//
// The last one does not exist in this binary at all. It is a *Kit* command
// that reached Hyper's recovery text, so a user following it verbatim gets the
// root help and no explanation.
//
// The property asserted here is that every command doctor prints can actually
// RUN — not that it is visible in the help. Those are different concerns and
// conflating them would force `visp-hyper init --force`, a deliberately
// advanced and destructive escape hatch, into the documented thirteen. The
// visibility question is tracked separately; a command that does not exist is
// a defect today.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { THIRTEEN_VERBS } from "../src/cli/index.js";
import { checkpointCommand } from "../src/cli/commands/checkpoint.js";
import { challengeCommand } from "../src/cli/commands/challenge.js";
import { guardCommand } from "../src/cli/commands/guard.js";
import { hooksCommand } from "../src/cli/commands/hooks.js";
import { initCommand } from "../src/cli/commands/init.js";
import { quickCommand } from "../src/cli/commands/quick.js";
import { rememberCommand } from "../src/cli/commands/remember.js";
import { reportCommand } from "../src/cli/commands/report.js";
import { resumeCommand } from "../src/cli/commands/resume.js";
import { reviewCommand } from "../src/cli/commands/review.js";
import { runCommand } from "../src/cli/commands/run.js";
import { serveCommand } from "../src/cli/commands/serve.js";
import { startCommand } from "../src/cli/commands/start.js";

const here = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(here, "..", "src", "cli", "commands");
const DOCTOR_ENTRY = join(COMMANDS_DIR, "doctor.ts");
const DOCTOR_CHECKS_DIR = join(COMMANDS_DIR, "doctor");

/**
 * Every source file that can contribute a recovery string: the command entry
 * plus each grouped check module beside it.
 *
 * Reading the whole directory rather than one path is what keeps this property
 * from quietly narrowing. The recovery text used to live in a single file; when
 * the checks were grouped into `doctor/`, a single-file read still found two
 * strings and would have kept "passing" over almost none of the surface.
 */
async function doctorSource(): Promise<string> {
  const checkModules = (await readdir(DOCTOR_CHECKS_DIR)).filter((name) => name.endsWith(".ts"));
  const sources = await Promise.all(
    [DOCTOR_ENTRY, ...checkModules.map((name) => join(DOCTOR_CHECKS_DIR, name))].map((path) =>
      readFile(path, "utf8")
    )
  );
  return sources.join("\n");
}

/**
 * Every command name Hyper registers — the thirteen verbs plus the legacy
 * surface that is hidden from `--help` but still runnable.
 */
function registeredCommands(): ReadonlySet<string> {
  const hidden = [
    initCommand(),
    startCommand(),
    runCommand(),
    quickCommand(),
    resumeCommand(),
    checkpointCommand(),
    challengeCommand(),
    guardCommand(),
    hooksCommand(),
    reviewCommand(),
    rememberCommand(),
    reportCommand(),
    serveCommand()
  ].map((command) => command.name());
  return new Set([...THIRTEEN_VERBS, ...hidden]);
}

/**
 * Pull the command out of every `` `visp …` `` recovery string in the source.
 *
 * Reading the source rather than driving doctor through every possible broken
 * project state is deliberate: the states that produce these strings are
 * exactly the ones hardest to construct, which is how a dead command survived
 * in one of them.
 */
async function recommendedCommands(): Promise<readonly string[]> {
  const source = await doctorSource();
  return [...source.matchAll(/`(visp(?:-hyper|-kit|-memory)?\s+[^`]+)`/gu)].map(([, command]) =>
    // Inside a template literal the backtick is escaped, so a match can end
    // with the escaping backslash. Strip it rather than reporting `visp
    // doctor\` as an unregistered command.
    command.replace(/\\$/u, "").trim()
  );
}

describe("every command doctor recommends is a real command", () => {
  it("finds recovery commands to check", async () => {
    // Guards the guard: if the extraction silently matched nothing, every
    // assertion below would pass while checking nothing at all.
    const commands = await recommendedCommands();
    expect(
      commands.length,
      "No recovery commands were extracted from doctor.ts. The source shape moved and this " +
        "property is no longer being checked — fix the extraction rather than deleting the test."
    ).toBeGreaterThan(5);
  });

  it("recommends no command this binary does not register", async () => {
    const registered = registeredCommands();
    const offenders: string[] = [];

    for (const command of await recommendedCommands()) {
      const [binary, subcommand] = command.split(/\s+/u);
      // Only `visp` and `visp-hyper` are this binary. A recommendation naming
      // visp-kit or visp-memory is about a different product and is out of
      // scope here.
      if (binary !== "visp" && binary !== "visp-hyper") continue;
      if (subcommand !== undefined && !registered.has(subcommand)) {
        offenders.push(command);
      }
    }

    expect(
      offenders,
      `doctor recommends ${offenders.length} command(s) this binary does not have. A user ` +
        "following them verbatim gets the root help and no explanation. Registered: " +
        [...registered].sort().join(", ")
    ).toEqual([]);
  });

  it("no longer offers a choice between two commands", async () => {
    // "Run `visp init` or `visp agent bootstrap <tool>`" gave two commands with
    // no basis for choosing — the undecidable-message defect fixed in Phase 12,
    // resurfaced. One cause, one command.
    const source = await doctorSource();
    const undecidable = [...source.matchAll(/recovery:[^\n]*`[^`]+`\s+or\s+`[^`]+`/gu)];

    expect(
      undecidable.map((match) => match[0]),
      "A recovery message offers two commands without telling the reader how to choose."
    ).toEqual([]);
  });

  it("does not leave a bare <tool> placeholder the user cannot resolve", async () => {
    // `--tool <tool>` rejected the obvious value `claude` and revealed the
    // allowed set only after failing. Where a tool must be named, name it.
    const source = await doctorSource();
    const placeholders = [...source.matchAll(/recovery:[^\n]*--tool <tool>/gu)];

    expect(
      placeholders.map((match) => match[0]),
      "A recovery message asks for --tool <tool> without saying which values are accepted."
    ).toEqual([]);
  });
});
