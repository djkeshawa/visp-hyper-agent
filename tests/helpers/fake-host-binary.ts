import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
