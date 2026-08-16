/**
 * The two facts every surface that talks about visp-memory has to agree on:
 * what installs it, and what proves a project has a store.
 *
 * Both were duplicated string literals before, and both had already drifted.
 * `visp-memory.yaml` appeared in four places; the install command appeared in
 * four and one copy disagreed — `memory-cli-contract.ts` said `pip install
 * visp-memory`, with no extras, and that is the copy a user in `llm-memory`
 * mode actually reaches.
 *
 * The bare copy fails soft, which is why it survived. Without the `capture`
 * extra there is no gitpython, so `visp-memory init` still SUCCEEDS while
 * silently capturing no git history — the whole stated value — and `visp
 * recall` then returns nothing with no link back to the install line that
 * caused it.
 *
 * This module has no imports on purpose: everything from `cli/` to `memory/`
 * can depend on it without creating a cycle.
 */

/** The file `visp-memory init` writes beside a project it has a store for. */
export const MEMORY_STORE_MANIFEST = "visp-memory.yaml";

/**
 * How to install visp-memory with the extras Visp actually needs: `mcp` for
 * the server surface and `capture` for git-history seeding. Both are declared
 * in visp-memory's own pyproject.
 *
 * The extras spec is quoted because zsh treats `[...]` as a glob: it matches
 * nothing, `NOMATCH` aborts the line, and pip never runs. zsh is macOS's
 * default login shell, so an unquoted form is a command half our users cannot
 * paste. bash passes it through literally, which is exactly why an unquoted
 * copy shipped and measured clean on Linux.
 */
export const MEMORY_INSTALL_COMMAND = "pip install 'visp-memory[mcp,capture]'";

/**
 * What to offer a reader who cannot run the install — no pip on a machine
 * whose Visp came from npm is an ordinary situation, and every remedy that
 * assumed pip left them with nothing to do.
 *
 * Memory is optional by design (D-118); saying so is what keeps a missing
 * optional dependency from reading like a broken install.
 */
export const MEMORY_OPT_OUT_CLAUSE =
  "No pip, or do not want Memory? Run `visp init --memory-mode file` — everything else works without it.";
