import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Which Kit build the live contract test drives.
 *
 * This is a helper rather than four lines inside
 * `tests/visp-binary-contract.test.ts` because the rule it encodes is the one
 * that makes a pair-check record mean anything: the Kit that
 * `scripts/pair-check.mjs` probed, named in the record, and reported on must
 * be the Kit the contract test actually ran against. The script passes it
 * through `$VISP_KIT_PATH`.
 *
 * Precedence: `$VISP_KIT_PATH`, then the sibling `../visp-kit` checkout. A
 * named Kit that does not resolve is an error and never a fallback — quietly
 * exercising a different Kit than the one you were handed is exactly the
 * mis-attribution the record exists to prevent.
 */
export type KitEntrySource = "env" | "sibling" | "none";

export interface KitEntryResolution {
  /** Absolute path to the Kit `dist/index.js`, or null when none was found. */
  entry: string | null;
  source: KitEntrySource;
}

export function resolveKitEntry(options: {
  repoRoot: string;
  env?: { VISP_KIT_PATH?: string | undefined };
  exists?: (path: string) => boolean;
}): KitEntryResolution {
  const { repoRoot } = options;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const named = env.VISP_KIT_PATH;
  if (named !== undefined && named !== "") {
    const entry = join(named, "dist", "index.js");
    if (!exists(entry)) {
      throw new Error(
        `VISP_KIT_PATH is set to ${named} but ${entry} does not exist. Refusing to fall back to another Kit: ` +
          `a contract run must exercise the Kit it names. Build that checkout, or unset VISP_KIT_PATH.`
      );
    }
    return { entry, source: "env" };
  }

  const sibling = join(repoRoot, "..", "visp-kit", "dist", "index.js");
  return exists(sibling) ? { entry: sibling, source: "sibling" } : { entry: null, source: "none" };
}
