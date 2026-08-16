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

import { THIRTEEN_VERBS } from "../../../../../src/cli/index.js";
import { checkpointCommand } from "../../../../../src/cli/commands/checkpoint.js";
import { challengeCommand } from "../../../../../src/cli/commands/challenge.js";
import { guardCommand } from "../../../../../src/cli/commands/guard.js";
import { hooksCommand } from "../../../../../src/cli/commands/hooks.js";
import { initCommand } from "../../../../../src/cli/commands/init.js";
import { quickCommand } from "../../../../../src/cli/commands/quick.js";
import { rememberCommand } from "../../../../../src/cli/commands/remember.js";
import { reportCommand } from "../../../../../src/cli/commands/report.js";
import { resumeCommand } from "../../../../../src/cli/commands/resume.js";
import { reviewCommand } from "../../../../../src/cli/commands/review.js";
import { runCommand } from "../../../../../src/cli/commands/run.js";
import { serveCommand } from "../../../../../src/cli/commands/serve.js";
import { startCommand } from "../../../../../src/cli/commands/start.js";

const here = dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = join(here, "..", "..", "..", "..", "..", "src", "cli", "commands");
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
 *
 * Returned per file, never concatenated, so a value at the end of one file
 * cannot run into the next.
 */
async function doctorSources(): Promise<readonly string[]> {
  const checkModules = (await readdir(DOCTOR_CHECKS_DIR)).filter((name) => name.endsWith(".ts"));
  return await Promise.all(
    [DOCTOR_ENTRY, ...checkModules.map((name) => join(DOCTOR_CHECKS_DIR, name))].map((path) =>
      readFile(path, "utf8")
    )
  );
}

// --- Reading what doctor reports, not what its source happens to say --------
//
// This used to match backticks anywhere in the file text, comments included, so
// a docstring that named a command was judged as if doctor recommended it. That
// makes prose a test input: the only way to keep the suite green is to reword a
// comment, which is editing the evidence rather than the behaviour. The scan is
// now confined to the values doctor actually emits.
//
// This is a scanner, not a parser. It understands strings, template
// substitutions and nesting — enough for the shapes in `doctor/` — and would be
// defeated by a regular-expression literal containing a quote or bracket. That
// failure mode is loud rather than silent: the extraction count drops and the
// guard-the-guard test below fails.

const QUOTES = new Set(["'", '"', "`"]);

/** Index just past the string or template literal starting at `start`. */
function endOfLiteral(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      index = endOfGroup(source, index + 2);
      continue;
    }
    index += 1;
  }
  return source.length;
}

/** Index just past the `}` closing a template substitution opened before `start`. */
function endOfGroup(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (QUOTES.has(char)) {
      index = endOfLiteral(source, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "}") {
      if (depth === 0) return index + 1;
      depth -= 1;
    }
    index += 1;
  }
  return source.length;
}

/**
 * Index of the delimiter ending the value expression that starts at `start` —
 * a top-level `,` or `;`, or a closer this value did not open. Everything
 * before it is the value, however many lines it spans.
 */
function endOfValue(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index]!;
    if (QUOTES.has(char)) {
      index = endOfLiteral(source, index);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && (char === "," || char === ";")) return index;
    index += 1;
  }
  return source.length;
}

/** The same source with every comment removed and nothing else changed. */
function withoutComments(source: string): string {
  let kept = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (QUOTES.has(char)) {
      const end = endOfLiteral(source, index);
      kept += source.slice(index, end);
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    kept += char;
    index += 1;
  }
  return kept;
}

function valuesIntroducedBy(source: string, introducer: RegExp): string[] {
  const code = withoutComments(source);
  return [...code.matchAll(introducer)].map((match) => {
    const start = match.index + match[0].length;
    return code.slice(start, endOfValue(code, start));
  });
}

/**
 * Every string doctor offers as a way forward: the value of each `recovery:`
 * field, plus **every module-level exported constant in `doctor/`**.
 *
 * The constants are here because `setup-route.ts` holds two recovery strings
 * under names — `recovery: route` is still a recovery string, and dropping them
 * would take `visp setup` and the hidden `visp init` out of the property.
 *
 * The second pattern used to be described as "the route constants those fields
 * are assigned from" while matching every exported SCREAMING_CASE name. Both
 * constants that exist today are routes, so the two readings agree and nothing
 * was wrong — but a reader debugging a failure would have been told the guard
 * was not looking where it was. **The breadth is what is kept and the sentence
 * is what changed**, for the same reason `doctorSources` reads the whole
 * directory: a name-shaped filter cannot fail loudly. `_ROUTE` in the pattern
 * would silently drop a future recovery constant called `SETUP_HINT`, and the
 * pinned counts below only catch the extraction shrinking, never its failing to
 * grow.
 *
 * What the breadth costs: a constant in `doctor/` that is not user-facing text
 * is scanned too. It contributes nothing unless it contains a backticked
 * `visp …` command — and a constant in doctor's own directory naming a command
 * this binary does not register is a defect wherever it is declared.
 */
async function recoveryValues(): Promise<readonly string[]> {
  const sources = await doctorSources();
  return sources.flatMap((source) => [
    ...valuesIntroducedBy(source, /\brecovery\s*:/gu),
    ...valuesIntroducedBy(source, /\bexport const [A-Z][A-Z0-9_]*\s*=/gu)
  ]);
}

/** Every string doctor prints about a check: its recovery and its detail. */
async function reportedValues(): Promise<readonly string[]> {
  const sources = await doctorSources();
  return [
    ...(await recoveryValues()),
    ...sources.flatMap((source) => valuesIntroducedBy(source, /\bdetail\s*:/gu))
  ];
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
 * Pull the command out of every `` `visp …` `` doctor reports.
 *
 * Reading the source rather than driving doctor through every possible broken
 * project state is deliberate: the states that produce these strings are
 * exactly the ones hardest to construct, which is how a dead command survived
 * in one of them.
 */
async function recommendedCommands(): Promise<readonly string[]> {
  return (await reportedValues()).flatMap((value) =>
    [...value.matchAll(/`(visp(?:-hyper|-kit|-memory)?\s+[^`]+)`/gu)].map(([, command]) =>
      // Inside a template literal the backtick is escaped, so a match can end
      // with the escaping backslash. Strip it rather than reporting `visp
      // doctor\` as an unregistered command.
      command.replace(/\\$/u, "").trim()
    )
  );
}

// The extraction as it stands today. A floor of `> 5` was the old guard, and
// it was met by six of the forty-odd commands doctor reports — so an extraction
// that lost most of the surface still passed. Pinned to the measured counts
// instead: growth is fine, shrinking is the failure this test exists to catch.
const EXTRACTED_COMMANDS = 26;
const EXTRACTED_RECOVERY_VALUES = 31;

describe("every command doctor recommends is a real command", () => {
  it("still finds every recovery command it used to", async () => {
    // Guards the guard: if the extraction silently narrowed, every assertion
    // below would pass while checking less than it used to — or nothing at all.
    const commands = await recommendedCommands();
    expect(
      commands.length,
      `Extraction found ${commands.length} reported commands, below the ${EXTRACTED_COMMANDS} ` +
        "this property was pinned at. The source shape moved and part of doctor is no longer " +
        "being checked — fix the extraction rather than lowering the floor."
    ).toBeGreaterThanOrEqual(EXTRACTED_COMMANDS);
  });

  it("still inspects every recovery value it used to", async () => {
    // The two narrow assertions below read recovery values one at a time. They
    // previously anchored on `recovery:[^\n]*` and so had never seen a value
    // spanning more than one line — `checkMemory`'s among them. Count the
    // values, not just the commands, or that blind spot can reopen silently.
    const values = await recoveryValues();
    expect(
      values.length,
      `Extraction found ${values.length} recovery values, below the ${EXTRACTED_RECOVERY_VALUES} ` +
        "this property was pinned at."
    ).toBeGreaterThanOrEqual(EXTRACTED_RECOVERY_VALUES);
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
    const undecidable = (await recoveryValues()).filter((value) =>
      /`[^`]+`[\s\S]*?\bor\b[\s\S]*?`[^`]+`/u.test(value)
    );

    expect(
      undecidable,
      "A recovery message offers two commands without telling the reader how to choose."
    ).toEqual([]);
  });

  it("does not leave a bare <tool> placeholder the user cannot resolve", async () => {
    // `--tool <tool>` rejected the obvious value `claude` and revealed the
    // allowed set only after failing. Where a tool must be named, name it.
    const placeholders = (await recoveryValues()).filter((value) =>
      value.includes("--tool <tool>")
    );

    expect(
      placeholders,
      "A recovery message asks for --tool <tool> without saying which values are accepted."
    ).toEqual([]);
  });
});
