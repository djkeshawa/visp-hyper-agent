import { vi } from "vitest";

const REAL_PLATFORM = process.platform;

/**
 * Run `body` with `process.platform` reporting `platform`, against freshly
 * imported modules.
 *
 * Windows path resolution cannot be exercised any other way on a POSIX runner,
 * and `it.runIf(process.platform === "win32")` is not an alternative: it
 * deletes the assertion on every machine the crew and CI actually run, which is
 * how a resolver shipped preferring an extensionless `visp-kit` over the
 * `visp-kit.cmd` beside it (LC-60).
 *
 * The module registry is reset around the override because the modules under
 * test read `process.platform` once, at import time, into a module-level
 * constant. Without the reset the override would be invisible to them.
 *
 * What this CANNOT emulate is Windows runtime behaviour of the OS itself —
 * notably that `fs.access` ignores `X_OK` there and calls every existing file
 * executable. Code whose correctness depends on that is verified by not asking
 * `X_OK` on win32 at all, which this override does prove.
 */
export async function withPlatform<T>(
  platform: NodeJS.Platform,
  body: () => Promise<T>
): Promise<T> {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  vi.resetModules();
  try {
    return await body();
  } finally {
    Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true });
    vi.resetModules();
  }
}
