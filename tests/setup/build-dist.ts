import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileResolved } from "../../src/core/executable-resolver.js";

/**
 * THE build precondition for this suite. Vitest runs this once, in the main
 * process, before a single test file is collected — so `dist/index.js` exists
 * and matches `src/` for every test in the run, with no test having to ask.
 *
 * WHY IT LIVES HERE AND NOWHERE ELSE
 *
 * Several suites drive the published artifact rather than the source: they
 * spawn `node dist/index.js`, or call `renderGitHookContent`, which resolves
 * `dist/index.js` to write a hook's command line, or `npm pack`, which computes
 * the tarball from `files` + disk (and runs with `--ignore-scripts`, so
 * `prepack` never fires).
 *
 * Each of those had, or grew, its own `beforeAll` build. That repair is
 * per-test by construction: it fixes the file it is written in and leaves the
 * next author to rediscover the rule. Measured on a fresh clone of 6a6b58b at
 * develop with `dist/` absent, each of these FAILED on its first run when run
 * alone, and passed in a full-suite run only because some other file's
 * `beforeAll` had happened to build first:
 *
 *     vitest run tests/degradation-regressions.test.ts   2 failed | 9 passed
 *     vitest run tests/hooks-command.test.ts             2 failed | 5 passed
 *     vitest run tests/mcp-server.test.ts                1 failed | 105 passed
 *
 * hooks-command and mcp-server each already HAD a `beforeAll` build — in a
 * later `describe` than the tests that needed it. A precondition you have to
 * remember to place is a precondition you will misplace.
 *
 * WHY NOT A CONDITIONAL, AND NEVER A SKIP
 *
 * The build is unconditional. Checking `existsSync(dist/index.js)` first would
 * accept a stale artifact built from different source, which makes a test
 * report on code that is not the code under test — the same silent wrongness as
 * skipping. A suite that skips when `dist/` is absent is worse still: it goes
 * green on a machine where the thing it tests is broken. `tsup` rebuilds this
 * package in about five seconds, which is the whole price of never wondering.
 *
 * Failure here aborts the run before any test reports anything, which is the
 * loud outcome: no test result is more trustworthy than the artifact it ran
 * against.
 */
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const distIndex = join(packageRoot, "dist", "index.js");

export async function setup(): Promise<void> {
  try {
    await execFileResolved("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
  } catch (error) {
    throw new Error(
      `The test suite could not build dist/. Every test runs against the built ` +
        `artifact, so the run is aborted rather than reporting results from a ` +
        `missing or stale one. Fix the build (\`pnpm build\`) and re-run.\n` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }

  // A build that exits 0 without producing the entry point would otherwise
  // surface much later as MODULE_NOT_FOUND inside a spawned child process.
  try {
    await access(distIndex);
  } catch {
    throw new Error(
      `\`pnpm build\` reported success but ${distIndex} does not exist. The ` +
        `suite cannot run against an artifact that is not there.`
    );
  }
}
