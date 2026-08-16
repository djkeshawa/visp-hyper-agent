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

/** The file `visp-memory init` writes beside a project it has a store for. */
export const MEMORY_STORE_MANIFEST = "visp-memory.yaml";

export type MemoryGap = {
  /** What is absent, stated so the reader can check it themselves. */
  readonly missing: string;
  /** The one command that closes this gap. */
  readonly remedy: string;
};

/**
 * Why Memory is unreachable here. Called only once a verb has decided to
 * refuse, so it always has something to report — the mode being wrong is
 * itself the last cause.
 */
export async function describeMemoryGap(projectPath: string): Promise<MemoryGap> {
  if ((await findExecutableOnPath("visp-memory")) === null) {
    return {
      missing: "the visp-memory CLI is not installed on this machine.",
      // The extras spec is quoted because zsh globs `[...]`, finds no match, and
      // aborts the line with `no matches found` before pip runs. zsh is macOS's
      // default login shell, so an unquoted remedy is a command half our users
      // cannot paste. bash passes it through literally, which is why this is
      // invisible on Linux.
      remedy: "Install it with `pip install 'visp-memory[mcp,capture]'`, then run `visp setup`."
    };
  }

  if (!(await fileExists(join(projectPath, MEMORY_STORE_MANIFEST)))) {
    return {
      missing:
        `visp-memory is installed, but this project has no memory store — there is no ${MEMORY_STORE_MANIFEST} here.`,
      remedy: "Run `visp-memory init` in this project, then `visp setup`."
    };
  }

  return {
    missing:
      "visp-memory is installed and this project has a store, but the project is still " +
      'configured for file memory (memoryMode is not "llm-memory").',
    remedy: "Run `visp setup` to point this project at the store it already has."
  };
}

/** The refusal both verbs print, so the two never drift apart. */
export function renderMemoryRefusal(verb: string, gap: MemoryGap, consequence: string): string {
  return [`visp ${verb} did not run: ${gap.missing}`, gap.remedy, consequence].join("\n");
}
