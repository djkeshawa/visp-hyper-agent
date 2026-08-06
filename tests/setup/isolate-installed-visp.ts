// The suite must not depend on what happens to be installed on the machine.
//
// Hyper spawns Kit by name: `resolveKitBinary` probes PATH for `visp-kit` and
// falls back to `visp` (src/kit/kit-binary-resolver.ts). That is correct in
// production and ruinous in a test run, because a globally installed Kit is
// then spawned against the temp fixture projects the tests build.
//
// Measured, on this repository, with the four products installed globally the
// way a user installs them:
//
//     with a globally installed visp-kit   187 failing
//     with it removed from PATH           1156 passing
//
// So the suite passed only while the developer had NOT installed the product it
// drives. Dogfooding broke the tests — which is precisely backwards, and it is
// the recurring defect of this codebase in a new place: those tests were
// passing because a binary was absent, not because the code was right. They
// would have gone green against a completely broken Kit.
//
// WHY NOT THE OBVIOUS FIXES
//
// Setting VISP_KIT_BINARY here would win over PATH and break the sixteen test
// files that legitimately stub Kit by putting a shim on PATH.
//
// Dropping the offending PATH directory wholesale would also remove `node`,
// `npm` and `visp-memory` — and tests/memory-contract-integration.test.ts
// deliberately requires the real visp-memory and FAILS rather than skips when
// it is missing, which is the right call for a contract test.
//
// So each directory that provides a Visp *Kit or coordinator* binary is
// replaced by a twin containing symlinks to everything it held except those
// binaries. Everything else on PATH survives untouched; only the ambient Kit
// disappears. A test that wants a Kit still prepends its own shim, exactly as
// before.

import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Binaries whose ambient presence changes what the suite tests.
 *
 * `visp-memory` is deliberately NOT here: the memory contract test drives the
 * real binary on purpose.
 */
const SHADOWED = new Set(["visp", "visp-kit", "visp-hyper"]);

/** Stable name so the farm is built once and shared across workers. */
const FARM_ROOT = join(tmpdir(), "visp-hyper-test-path");

function sanitisedTwin(directory: string, index: number): string {
  const twin = join(FARM_ROOT, `dir-${index}`);
  if (existsSync(twin)) return twin;

  mkdirSync(twin, { recursive: true });
  for (const entry of readdirSync(directory)) {
    if (SHADOWED.has(entry)) continue;
    try {
      symlinkSync(join(directory, entry), join(twin, entry));
    } catch {
      // A parallel worker won the race, or the entry vanished. Either way the
      // link either exists already or was never needed.
    }
  }
  return twin;
}

function providesShadowedBinary(directory: string): boolean {
  try {
    return readdirSync(directory).some((entry) => SHADOWED.has(entry));
  } catch {
    return false;
  }
}

const entries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
process.env.PATH = entries
  .map((directory, index) =>
    providesShadowedBinary(directory) ? sanitisedTwin(directory, index) : directory
  )
  .join(delimiter);
