// LC-94 — `visp --help` under-reported its own surface.
//
// The help listed the thirteen verbs. `init`, `hooks`, `guard`, `serve` and
// `review` ran, and none appeared. That is not tidiness: `doctor` tells users
// to run `visp hooks git`, and `visp init --memory-mode` and `--with-hooks` are
// the documented repairs for a disabled memory bridge (LC-93) and for
// unenforced task scopes. Every one of them was invisible to a reader of
// `--help`, human or agent.
//
// The property below is asserted against the COMMAND REGISTRY, never a list
// written out here. A hand-kept list is exactly what drifted: it would pass on
// the day it was written and say nothing the next time a command was added.

import type { Command } from "commander";
import { describe, expect, it } from "vitest";

import { buildProgram, THIRTEEN_VERBS } from "../../../src/cli/index.js";

/**
 * What `visp --help` prints, captured from the path `--help` actually takes.
 *
 * `helpInformation()` is NOT that path: it renders Commander's own sections and
 * skips the `addHelpText` hooks, so a test reading it would have judged the
 * additional-commands section that does not exist there — and reported it
 * missing from a help text where it is present.
 */
function renderHelp(program: Command): string {
  let captured = "";
  program.configureOutput({ writeOut: (text) => { captured += text; } });
  program.outputHelp();
  return captured;
}

describe("visp --help", () => {
  it("names every command the binary registers", () => {
    const program = buildProgram();
    const help = renderHelp(program);

    const missing = program.commands
      .map((command) => command.name())
      // Anchored to a help LIST ENTRY, not to the name appearing anywhere. A
      // loose match is satisfied by prose: `checkpoint` occurs in `save`'s
      // description, so a bare substring search reported it present on a help
      // text that never listed it.
      .filter((name) => !new RegExp(`^\\s+${name}\\s`, "mu").test(help));

    expect(
      missing,
      `${missing.length} registered command(s) do not appear in \`visp --help\`. A command a user ` +
        "can run and cannot discover is a command that does not exist for them — and doctor " +
        "recommends some of these by name."
    ).toEqual([]);
  });

  it("describes every command it names, so the list is usable and not just complete", () => {
    const program = buildProgram();

    const undescribed = program.commands
      .filter((command) => command.description().trim() === "")
      .map((command) => command.name());

    expect(undescribed).toEqual([]);
  });

  it("still presents the thirteen verbs as the primary surface", () => {
    // Completeness must not cost the shape. The thirteen stay in Commander's
    // own `Commands:` list; everything else is named below it.
    const program = buildProgram();
    const primary = program
      .createHelp()
      .visibleCommands(program)
      .map((command) => command.name())
      .filter((name) => name !== "help");

    expect(primary).toEqual([...THIRTEEN_VERBS]);
  });

  it("registers more commands than the thirteen, which is why the extra section exists", () => {
    // Guards the guard: if every command became visible, the first property
    // above would pass while proving nothing about the section it was written
    // for.
    const program = buildProgram();
    const listed = new Set(program.createHelp().visibleCommands(program).map((c) => c.name()));

    expect(program.commands.filter((c) => !listed.has(c.name())).length).toBeGreaterThan(0);
  });
});
