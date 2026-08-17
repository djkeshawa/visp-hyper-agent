// LC-94 — what a user actually sees when they run `visp --help`.
//
// The registry property lives in `tests/unit/cli/index.test.ts`; this drives
// the shipped binary, because the defect was reported against the installed
// command and the rendering runs through a bundler on the way there.
//
// The five commands asserted by name are the ones verified missing on the
// ticket. They are named here deliberately: this file is the reproduction, and
// a reproduction that only restates the general property cannot show that the
// specific report was fixed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildProgram } from "../../../../src/cli/index.js";
import { distIndex, packageRoot } from "../../../helpers/dist-paths.js";

const execFileAsync = promisify(execFile);

async function renderHelp(): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [distIndex, "--help"], {
    cwd: packageRoot
  });
  return stdout;
}

describe("the installed `visp --help`", () => {
  it("names the commands the ticket found missing", async () => {
    const help = await renderHelp();

    for (const command of ["init", "hooks", "guard", "serve", "review"]) {
      expect(
        help,
        `\`visp ${command}\` runs and \`visp --help\` does not mention it. doctor tells users to ` +
          "run `visp hooks git`, and `visp init --memory-mode` is LC-93's documented repair."
      ).toMatch(new RegExp(`^\\s+${command}\\s`, "mu"));
    }
  }, 60_000);

  it("names every command the binary registers, not only those five", async () => {
    // The five above are the report; the registry is the property. Read from
    // the program itself so a command added tomorrow is covered without anyone
    // remembering to add it here.
    const help = await renderHelp();
    const missing = buildProgram()
      .commands.map((command) => command.name())
      .filter((name) => !new RegExp(`^\\s+${name}\\s`, "mu").test(help));

    expect(missing).toEqual([]);
  }, 60_000);
});
