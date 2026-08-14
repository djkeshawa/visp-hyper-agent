import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileResolved } from "../../src/core/executable-resolver.js";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const distIndex = join(packageRoot, "dist", "index.js");

/**
 * Any test that packs this package needs `dist/` on disk: `npm pack` computes
 * the tarball from `files` + disk, and the suites run with `--ignore-scripts`
 * so `prepack` never fires. The package `test` script builds first, but a bare
 * `vitest run` on a clean clone does not — which used to make the packed-pair
 * smoke fail on the first run and pass on the second, once an earlier suite's
 * hook had happened to build. A test that needs a second try is untrustworthy,
 * so every packing suite calls this itself instead of depending on which suite
 * in the file ran first.
 *
 * The build is idempotent and the promise is memoised, so concurrent callers
 * inside one worker share a single `pnpm build`.
 */
let buildOnce: Promise<void> | undefined;

export async function ensureHyperDist(): Promise<void> {
  buildOnce ??= (async () => {
    try {
      await access(distIndex);
      return;
    } catch {
      // Not built yet.
    }
    await execFileResolved("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
    // A build that reports success without producing the entry point would
    // otherwise surface as a confusing MODULE_NOT_FOUND inside a child process.
    await access(distIndex);
  })();
  await buildOnce;
}

export { distIndex, packageRoot };
