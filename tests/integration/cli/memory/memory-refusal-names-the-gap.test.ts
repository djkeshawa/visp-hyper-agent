// LC-14 — `recall` and `learn` say which thing is missing.
//
// In a full workflow run the treatment arm was told to exercise both verbs at
// least once. Neither did anything, and the round produced no evidence about
// Memory at all. Both verbs refused with the same sentence — "needs
// visp-memory, which is not configured for this project" — and the same remedy,
// `visp setup`, for three unrelated causes:
//
//   1. the visp-memory CLI is not installed on the machine
//   2. it is installed, but this project has no store
//   3. store and CLI are both there, but the project still uses file memory
//
// One message for three causes is a message that cannot be acted on. Refusing
// visibly is the design (D-118); refusing indistinguishably is the defect.
//
// PATH and the store file are both controlled here, so the assertions do not
// depend on what the machine running the suite happens to have installed.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeProject } from "../../../../src/core/session-manager.js";
import { runLearnVerb, runRecallVerb } from "../../../../src/cli/memory/memory-verbs.js";
import {
  MEMORY_INSTALL_COMMAND,
  MEMORY_STORE_MANIFEST
} from "../../../../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "../../../helpers/fake-host-binary.js";

let tempDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "visp-memory-gap-"));
  originalPath = process.env.PATH;
  // The default mode is file memory, which is the state every one of these
  // cases starts from.
  await initializeProject(tempDir, false);
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.exitCode = 0;
  vi.restoreAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

type Machine = {
  /** Whether a `visp-memory` command can be found on PATH. */
  readonly cliInstalled: boolean;
  /** Whether this project has a store. */
  readonly storePresent: boolean;
  /** The mode the project is configured for. Defaults to file, as a fresh project is. */
  readonly memoryMode?: "file" | "llm-memory";
};

async function arrange(machine: Machine): Promise<void> {
  if (machine.memoryMode === "llm-memory") {
    const configPath = join(tempDir, ".visp", "hyper", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, memoryMode: "llm-memory" }, null, 2)}\n`,
      "utf8"
    );
  }

  process.env.PATH = machine.cliInstalled
    ? await createFakeHostBinaryDir("visp-memory", "0.5.0")
    : await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

  if (machine.storePresent) {
    await writeFile(join(tempDir, MEMORY_STORE_MANIFEST), "repo_id: demo\n", "utf8");
  }
}

/** Capture what a verb printed when it refused. */
async function refusalFrom(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
  await run();
  return lines.join("\n");
}

describe("recall and learn when memory is unreachable", () => {
  it("names the missing CLI when nothing is installed", async () => {
    await arrange({ cliInstalled: false, storePresent: false });

    const output = await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

    expect(output).toContain("the visp-memory CLI is not installed on this machine");
    expect(output, "the remedy has to be the install, not a setup that cannot help yet").toContain(
      MEMORY_INSTALL_COMMAND
    );
  });

  it("names the missing store when the CLI is installed but the project has none", async () => {
    await arrange({ cliInstalled: true, storePresent: false });

    const output = await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

    expect(output).toContain(MEMORY_STORE_MANIFEST);
    expect(output).toContain("visp-memory init");
    expect(
      output,
      "blaming the install when the install is fine is what left a whole round with no evidence " +
        "about Memory and nothing to act on."
    ).not.toContain("not installed on this machine");
  });

  it("names the configuration when the CLI and the store are both present", async () => {
    await arrange({ cliInstalled: true, storePresent: true });

    const output = await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

    expect(output).toContain("memoryMode");
    // `arrange` replaces PATH with a directory holding only visp-memory, so
    // there is no visp-dev and `visp setup` genuinely cannot run on this
    // simulated machine. The remedy has to be the one that does work — a
    // remedy chain for LC-14 that terminates in LC-9's dead end is the defect
    // both tickets exist to remove.
    expect(output).toContain("visp init --memory-mode llm-memory");
  });

  it("tells learn's reader the same three things, and that nothing was recorded", async () => {
    await arrange({ cliInstalled: true, storePresent: false });

    const output = await refusalFrom(() => runLearnVerb(tempDir, "screen wraps on four edges"));

    expect(output).toContain(MEMORY_STORE_MANIFEST);
    expect(
      output,
      "a refusal that does not say the write did not happen can be read as a success"
    ).toContain("Nothing was recorded.");
  });

  it("still fails rather than answering emptily", async () => {
    // The whole point of refusing out loud is that an empty answer and a real
    // one must never look alike.
    await arrange({ cliInstalled: false, storePresent: false });

    await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

    expect(process.exitCode).toBe(1);
  });

  // The mode a user sets in order to GET Memory. The diagnosis above used to
  // sit behind `if (memoryMode !== "llm-memory")`, so none of it ran here: the
  // verbs fell through to the CLI contract and printed a bare install line with
  // no extras, or — for a missing store — "visp-memory answered outside
  // contract 1.0; upgrade visp-memory (needs >= 0.4.0)", which is a wrong
  // answer rather than merely a poor one.
  // Same machine, minutes apart from the good message. LC-14's origin was
  // Memory absent for a whole session, which is exactly this path.
  describe("in llm-memory mode", () => {
    it("names the missing CLI, not a bare contract failure", async () => {
      await arrange({ cliInstalled: false, storePresent: false, memoryMode: "llm-memory" });

      const output = await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

      expect(output).toContain("the visp-memory CLI is not installed on this machine");
      expect(
        output,
        "the contract's own message names no extras, and pip without `capture` installs a " +
          "visp-memory that captures no git history while still reporting success"
      ).toContain(MEMORY_INSTALL_COMMAND);
    });

    it("names the missing store instead of blaming the version of a correct binary", async () => {
      await arrange({ cliInstalled: true, storePresent: false, memoryMode: "llm-memory" });

      const output = await refusalFrom(() => runRecallVerb(tempDir, "why jwt"));

      expect(output).toContain(MEMORY_STORE_MANIFEST);
      expect(output).toContain("visp-memory init");
      // The contract's answer for this case was "visp-memory answered outside
      // contract 1.0; upgrade visp-memory (needs >= 0.4.0)" — not merely
      // unhelpful but wrong, sending the user to upgrade a binary that is
      // installed and current when the real gap is that this project has no
      // store. That is the string to keep out, and unlike "Command failed" it
      // is one this codebase really produces.
      expect(
        output,
        "an upgrade instruction for a correctly installed binary is a confident misdiagnosis, " +
          "which costs more than saying nothing"
      ).not.toContain("upgrade visp-memory");
    });

    it("still refuses out loud rather than answering emptily", async () => {
      await arrange({ cliInstalled: false, storePresent: false, memoryMode: "llm-memory" });

      await refusalFrom(() => runLearnVerb(tempDir, "screen wraps on four edges"));

      expect(process.exitCode).toBe(1);
    });
  });

  it("gives the three causes three different answers", async () => {
    const answers: string[] = [];
    for (const machine of [
      { cliInstalled: false, storePresent: false },
      { cliInstalled: true, storePresent: false },
      { cliInstalled: true, storePresent: true }
    ]) {
      await rm(join(tempDir, MEMORY_STORE_MANIFEST), { force: true });
      await arrange(machine);
      answers.push(await refusalFrom(() => runRecallVerb(tempDir, "why jwt")));
    }

    expect(
      new Set(answers).size,
      "two of the three causes still produce the same sentence, so the reader cannot tell which " +
        "one they are in — the defect LC-14 reports."
    ).toBe(3);
  });
});
