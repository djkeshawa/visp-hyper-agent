import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * Create a directory containing a fake coding-host binary that prints `version`
 * for any arguments, so `doctor`'s `<host> --version` probe can be exercised
 * without installing a real host.
 *
 * An extensionless `#!/bin/sh` script is not executable on Windows at all — it
 * is not on PATHEXT, so the resolver never finds it and the probe reports the
 * host as missing. Mirror the shape a real global npm install writes, which is
 * also what {@link createVispShim} uses: a plain `.js` payload plus a `.cmd`
 * wrapper that `execFileCrossPlatform` runs through cmd.exe.
 *
 * Returns the directory to prepend to PATH.
 */
export async function createFakeHostBinaryDir(name: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-fake-host-"));

  if (WINDOWS) {
    const scriptPath = join(dir, `${name}-shim.js`);
    await writeFile(scriptPath, `process.stdout.write(${JSON.stringify(`${version}\n`)});\n`, "utf8");
    // `%~dp0` keeps the wrapper location-independent; no input is interpolated.
    await writeFile(
      join(dir, `${name}.cmd`),
      `@echo off\r\nnode "%~dp0${name}-shim.js" %*\r\n`,
      "utf8"
    );
    return dir;
  }

  const binary = join(dir, name);
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\n`, "utf8");
  await chmod(binary, 0o755);
  return dir;
}
