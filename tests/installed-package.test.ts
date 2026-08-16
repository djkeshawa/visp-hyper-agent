// LC-9 — a globally installed package is reachable, and Hyper can say where.
//
// `npm install -g visp-dev` puts `visp-dev` on PATH but nowhere on Hyper's
// node_modules chain, so `import("visp-dev/machine-scope")` throws. `visp setup`
// read that throw as "not installed" and told the user to run the install they
// had already run. The loop was closed and neither message showed a way out.
//
// What is asserted here is the question the failed import cannot answer: given
// a command that exists on PATH, where does its package live, and what file
// does the subpath export point at. The fixture is built in the layout `npm
// install -g` actually writes on the platform the test is running on, because
// the two layouts differ in exactly the way that matters — POSIX symlinks the
// bin into the package, win32 writes a shim beside `node_modules/`.

import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInstalledPackageExport } from "../src/core/installed-package.js";

const WINDOWS = process.platform === "win32";
const PACKAGE_NAME = "demo-adapter";
const SUBPATH = "./machine-scope";

let prefix: string;
let originalPath: string | undefined;

beforeEach(async () => {
  // realpath, because the code under test canonicalises the binary it finds
  // and this fixture has to be able to compare paths with what it returns.
  // On Windows `os.tmpdir()` hands back the 8.3 short form —
  // `C:\Users\RUNNER~1\...` — while realpath expands it to
  // `C:\Users\runneradmin\...`, so an unresolved fixture path is spelled
  // differently from the identical location the resolver reports.
  prefix = await realpath(await mkdtemp(join(tmpdir(), "visp-global-install-")));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(prefix, { recursive: true, force: true });
});

type GlobalInstall = {
  /** Directory to put on PATH. */
  readonly binDir: string;
  /** The installed package's root, wherever this platform's npm puts it. */
  readonly root: string;
  /** The file the subpath export should resolve to. */
  readonly adapter: string;
};

/**
 * Write the package itself. `exports` is given as the raw value so a test can
 * hand over a conditional object as well as a plain string.
 */
async function writePackage(root: string, exportsValue: unknown): Promise<string> {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });

  const adapter = join(root, "src", "adapter.mjs");
  await writeFile(adapter, "export const runSetup = async () => ({ success: true });\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, type: "module", exports: { [SUBPATH]: exportsValue } }, null, 2)}\n`,
    "utf8"
  );
  return adapter;
}

async function installGlobally(exportsValue: unknown = "./src/adapter.mjs"): Promise<GlobalInstall> {
  if (WINDOWS) {
    // The npm prefix holds the shim; the package sits in a sibling node_modules.
    const root = join(prefix, "node_modules", PACKAGE_NAME);
    const adapter = await writePackage(root, exportsValue);
    await writeFile(join(prefix, `${PACKAGE_NAME}.cmd`), "@echo off\r\n", "utf8");
    return { binDir: prefix, root, adapter };
  }

  const root = join(prefix, "lib", "node_modules", PACKAGE_NAME);
  const adapter = await writePackage(root, exportsValue);
  const entry = join(root, "scripts", "cli.mjs");
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await chmod(entry, 0o755);

  const binDir = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  await symlink(entry, join(binDir, PACKAGE_NAME));
  return { binDir, root, adapter };
}

function onlyOnPath(directory: string): void {
  process.env.PATH = directory;
}

async function resolveDemo(): Promise<string | null> {
  return resolveInstalledPackageExport({
    binary: PACKAGE_NAME,
    packageName: PACKAGE_NAME,
    subpath: SUBPATH
  });
}

describe("resolving a subpath export of a globally installed package", () => {
  it("finds the export from nothing but the command on PATH", async () => {
    const { binDir, adapter } = await installGlobally();
    onlyOnPath(binDir);

    expect(
      await resolveDemo(),
      "the package is installed and its command is on PATH, which is the whole of what a user " +
        "who ran `npm install -g` has done. Failing here is the dead end LC-9 reports."
    ).toBe(adapter);
  });

  it("resolves a conditional export the way an ESM import would", async () => {
    const { binDir, adapter } = await installGlobally({ import: "./src/adapter.mjs" });
    onlyOnPath(binDir);

    expect(await resolveDemo()).toBe(adapter);
  });

  it("reports nothing when the command is not on PATH at all", async () => {
    await installGlobally();
    onlyOnPath(await mkdtemp(join(tmpdir(), "visp-empty-path-")));

    expect(await resolveDemo()).toBeNull();
  });

  it("refuses a directory that only shares the package's name", async () => {
    // A parent directory called `demo-adapter` is not the package. Matching on
    // the name in package.json is what keeps a coincidence off the import path.
    // Overwrite where THIS platform's npm put the package. Reaching for the
    // POSIX `lib/node_modules` spelling wrote into a directory Windows does
    // not have, so the test failed on the fixture rather than on the claim.
    const { binDir, root } = await installGlobally();
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "something-else" })}\n`,
      "utf8"
    );
    onlyOnPath(binDir);

    expect(await resolveDemo()).toBeNull();
  });

  it("reports nothing when the package exports no such subpath", async () => {
    const { binDir } = await installGlobally();
    onlyOnPath(binDir);

    expect(
      await resolveInstalledPackageExport({
        binary: PACKAGE_NAME,
        packageName: PACKAGE_NAME,
        subpath: "./not-exported"
      })
    ).toBeNull();
  });

  it("reports nothing when the export points at a file that is not there", async () => {
    const { binDir } = await installGlobally("./src/missing.mjs");
    onlyOnPath(binDir);

    expect(
      await resolveDemo(),
      "returning a path that does not exist would move the failure to the import, where the " +
        "message is worse."
    ).toBeNull();
  });
});
