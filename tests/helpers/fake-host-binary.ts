import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEMORY_STORE_MANIFEST } from "../../src/memory/visp-memory-install.js";
import { writeNodeExecutable } from "./fake-executable.js";

/**
 * Create a directory containing a fake coding-host binary that prints `version`
 * for any arguments, so `doctor`'s `<host> --version` probe can be exercised
 * without installing a real host.
 *
 * Returns the directory to prepend to PATH.
 */
export async function createFakeHostBinaryDir(name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-fake-host-"));
  await writeNodeExecutable(
    dir,
    name,
    `process.stdout.write(${JSON.stringify(`${version}\n`)});`
  );
  return dir;
}

/**
 * A fake `visp-memory` whose `init` really creates a store — it writes
 * {@link MEMORY_STORE_MANIFEST} into its working directory, which is the one
 * observable act that makes a project's store exist.
 *
 * {@link createFakeHostBinaryDir} is not enough for any test about what setup
 * DOES with visp-memory: that fake prints a version for every argument, so
 * `visp-memory init` exits 0 and leaves no store, and `memoryStoreIsReachable`
 * then correctly reports the project as storeless. A test wanting to assert the
 * installed-and-initialised outcome outright has to arrange a CLI that can
 * reach it.
 *
 * Returns the directory to put on PATH.
 */
export async function createFakeMemoryCliDir(version = "0.5.0"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-fake-memory-cli-"));
  await writeNodeExecutable(
    dir,
    "visp-memory",
    [
      `const manifest = ${JSON.stringify(MEMORY_STORE_MANIFEST)};`,
      `if (process.argv[2] === "init") {`,
      `  const { writeFileSync } = require("node:fs");`,
      `  const { join } = require("node:path");`,
      `  writeFileSync(join(process.cwd(), manifest), "repo_id: fake\\n");`,
      `  process.stdout.write("initialised " + manifest + "\\n");`,
      `} else {`,
      `  process.stdout.write(${JSON.stringify(`${version}\n`)});`,
      `}`
    ].join("\n")
  );
  return dir;
}
