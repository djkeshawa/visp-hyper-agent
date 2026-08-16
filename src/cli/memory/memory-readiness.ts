/**
 * Naming what is missing when `recall` and `learn` cannot reach Memory.
 *
 * Both verbs refused with one sentence for three unrelated causes: the CLI not
 * installed, the CLI installed but this project holding no store, and a store
 * present but the project still configured for file memory. The remedy offered
 * was always `visp setup`. In a real workflow run that produced a project where
 * Memory was simply absent for the whole session and no message said which of
 * the three it was — so nothing could be acted on.
 *
 * Reporting only, in the order a user would fix them. Nothing here creates a
 * store or edits configuration.
 */

import { join } from "node:path";

import { findExecutableOnPath } from "../../core/executable-resolver.js";
import { fileExists } from "../../core/fs-utils.js";
import {
  MEMORY_INSTALL_COMMAND,
  MEMORY_OPT_OUT_CLAUSE,
  MEMORY_STORE_MANIFEST
} from "../../memory/visp-memory-install.js";
import { machineScopeAvailable } from "../machine/machine-scope.js";

export type MemoryGap = {
  /** What is absent, stated so the reader can check it themselves. */
  readonly missing: string;
  /** The one command that closes this gap. */
  readonly remedy: string;
};

/**
 * How to finish a repair once the missing piece is in place.
 *
 * `visp setup` is the short answer only on a machine that can run it. On one
 * without the Visp Dev machine-scope adapter it is the LC-9 dead end, and
 * pointing Memory's remedy at it would end LC-14's chain in LC-9's bug — a
 * report that says "`visp setup` cannot help here" and three lines later says
 * to run `visp setup`.
 */
async function finishClause(directAlternative: string): Promise<string> {
  return (await machineScopeAvailable())
    ? "then run `visp setup`."
    : `then run \`${directAlternative}\` — \`visp setup\` cannot help here, because it needs ` +
        "the Visp Dev machine-scope adapter and nothing on this machine provides it.";
}

/**
 * The gap that stops Memory being reachable here, or `null` when nothing is
 * missing and the verb should go ahead.
 *
 * Checked in the order a user would fix them, and deliberately independent of
 * `memoryMode`: the configuration being wrong is the LAST cause, not the gate.
 * It used to be the gate, and that made this whole diagnosis unreachable in
 * `llm-memory` mode — the mode a user sets in order to get Memory, and the one
 * LC-14 is actually about. In that mode the verbs fell through to the contract
 * and printed either a bare install line with no extras or a raw subprocess
 * dump, on the same machine, minutes apart from the good message.
 */
export async function findMemoryGap(
  projectPath: string,
  memoryMode: "file" | "llm-memory"
): Promise<MemoryGap | null> {
  if ((await findExecutableOnPath("visp-memory")) === null) {
    return {
      missing: "the visp-memory CLI is not installed on this machine.",
      remedy: [
        `Install it with \`${MEMORY_INSTALL_COMMAND}\`, ${await finishClause("visp init --memory-mode llm-memory")}`,
        MEMORY_OPT_OUT_CLAUSE
      ].join("\n")
    };
  }

  if (!(await fileExists(join(projectPath, MEMORY_STORE_MANIFEST)))) {
    return {
      missing: `visp-memory is installed, but this project has no memory store — there is no ${MEMORY_STORE_MANIFEST} here.`,
      remedy: `Run \`visp-memory init\` in this project, ${await finishClause("visp init --memory-mode llm-memory")}`
    };
  }

  if (memoryMode !== "llm-memory") {
    return {
      missing:
        "visp-memory is installed and this project has a store, but the project is still " +
        'configured for file memory (memoryMode is not "llm-memory").',
      remedy: (await machineScopeAvailable())
        ? "Run `visp setup` to point this project at the store it already has."
        : "Run `visp init --memory-mode llm-memory` to point this project at the store it already has."
    };
  }

  return null;
}

/** The refusal both verbs print, so the two never drift apart. */
export function renderMemoryRefusal(verb: string, gap: MemoryGap, consequence: string): string {
  return [`visp ${verb} did not run: ${gap.missing}`, gap.remedy, consequence].join("\n");
}
