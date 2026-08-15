import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Paths into the built package, for the suites that drive the published
 * artifact rather than the source.
 *
 * This file used to be `ensure-dist.ts` and export an `ensureHyperDist()` that
 * built on demand. Building on demand from inside a test was a per-test
 * repair: it worked in the file that called it, left every later author to
 * rediscover the rule, and — with `tsup`'s `clean: true` — let a build kicked
 * off by one worker delete `dist/` out from under a child process another
 * worker had just spawned. The build now happens once in
 * `tests/setup/build-dist.ts`, registered as Vitest's `globalSetup`, before any
 * test file is collected. Import these paths and use them; the artifact is
 * already there.
 */
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const distIndex = join(packageRoot, "dist", "index.js");

export { distIndex, packageRoot };
