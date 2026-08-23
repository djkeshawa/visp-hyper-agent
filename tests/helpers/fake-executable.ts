import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * The one place that knows how to put a runnable fake binary on disk.
 *
 * A POSIX fake is an extensionless `#!/usr/bin/env node` file with the execute
 * bit set. **Neither half of that exists on Windows.** There is no shebang, so
 * the file's first line is data; `chmod` is a no-op, so the execute bit is not
 * a concept; and an extensionless name is not on PATHEXT, so no resolver ever
 * matches it. A test that hand-rolls the POSIX shape does not get a failing
 * fake on Windows — it gets no fake at all, and the failure surfaces much
 * later as ENOENT, "command not found", or a production guard reporting
 * `refused` where the test expected `registered`.
 *
 * So Windows gets the shape a real `npm install -g` writes: a plain `.js`
 * payload plus a sibling `.cmd` wrapper that runs it under node.
 * {@link resolveExecutable} finds the `.cmd` through PATHEXT and runs it via
 * cmd.exe, which is the same path a real installed CLI takes.
 */

/**
 * Write `name` into `dir` as an executable running `body` under node, and
 * return the path callers should invoke — the `.cmd` wrapper on Windows, the
 * extensionless script elsewhere.
 *
 * `dir` is created if it does not exist.
 */
export async function writeNodeExecutable(
  dir: string,
  name: string,
  body: string
): Promise<string> {
  await mkdir(dir, { recursive: true });

  if (WINDOWS) {
    const payload = join(dir, `${name}-payload.js`);
    const wrapper = join(dir, `${name}.cmd`);
    await writeFile(payload, `${body}\n`, "utf8");
    // `%~dp0` keeps the wrapper location-independent and `%*` forwards argv
    // verbatim. This is a fixed template — no caller string reaches the shell.
    await writeFile(wrapper, `@echo off\r\nnode "%~dp0${name}-payload.js" %*\r\n`, "utf8");
    return wrapper;
  }

  const script = join(dir, name);
  await writeFile(script, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(script, 0o755);
  return script;
}

/**
 * The three writers below are deliberately NOT platform-adaptive, unlike
 * {@link writeNodeExecutable}. They exist to reproduce the ambiguity a real
 * `npm install -g` creates — two files, same stem, only one of them startable
 * on Windows — so a resolver can be asked which one it picks (LC-60). A test
 * that wants "a fake that works here" wants `writeNodeExecutable` instead.
 */

/**
 * The extensionless `#!/bin/sh` half, which npm writes for Git Bash. On win32
 * it is inert: no shebang support, `chmod` a no-op, and the name is not on
 * PATHEXT, so nothing can start it.
 */
export async function writePosixShim(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const shim = join(dir, name);
  await writeFile(shim, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(shim, 0o755);
  return shim;
}

/** The `.cmd` half — the only one `cmd.exe`/`CreateProcess` resolves. */
export async function writeCmdShim(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const shim = join(dir, `${name}.cmd`);
  await writeFile(shim, "@echo off\r\nexit /b 0\r\n", "utf8");
  return shim;
}

/** What a real `npm install -g` leaves in a global bin directory. */
export interface GlobalInstallShims {
  readonly posixShim: string;
  readonly cmdShim: string;
}

/** Both halves at once, as installed. */
export async function writeGlobalInstallShims(
  dir: string,
  name: string
): Promise<GlobalInstallShims> {
  return {
    posixShim: await writePosixShim(dir, name),
    cmdShim: await writeCmdShim(dir, name)
  };
}

/** A fake whose resolved path lives inside a package, plus the dir to put on PATH. */
export interface PackageResidentExecutable {
  /** The path the host will actually start. */
  readonly executable: string;
  /** The directory to place on PATH so the bare name resolves to it. */
  readonly pathDir: string;
}

/**
 * Put `name` where resolving it yields a path whose `realpath` lands inside
 * `packageDir` — the shape the self-invocation guard exists to detect.
 *
 * POSIX gets the symlink `npm install -g` really writes, so the guard's
 * `realpath` call is exercised against an actual link. Windows cannot have
 * that: an extensionless PATH entry is not resolvable there at all, and a
 * symlink is neither executable nor privilege-free (see tool-path.ts). So the
 * executable is written inside the package and that directory goes on PATH.
 *
 * Both arms establish the same property, and the CALLER'S ASSERTION IS
 * IDENTICAL on both — only the arrangement differs, which is this helper's
 * whole reason to exist. A test using it is not platform-skipped.
 */
export async function writePackageResidentExecutable(
  packageDir: string,
  binDir: string,
  name: string
): Promise<PackageResidentExecutable> {
  if (WINDOWS) {
    const executable = await writeNodeExecutable(packageDir, name, "process.exit(0);");
    return { executable, pathDir: packageDir };
  }

  const real = await writeNodeExecutable(packageDir, `${name}-real`, "process.exit(0);");
  await mkdir(binDir, { recursive: true });
  const link = join(binDir, name);
  await symlink(real, link);
  return { executable: link, pathDir: binDir };
}

/**
 * Write a node-backed fake `name` into `binDir` and prepend that directory to
 * `process.env.PATH`, so production code resolving the bare command finds it.
 *
 * Restoring PATH is the caller's job — every test doing this already keeps the
 * original in an `afterEach`.
 */
export async function putNodeExecutableOnPath(
  binDir: string,
  name: string,
  body: string
): Promise<string> {
  const executable = await writeNodeExecutable(binDir, name, body);
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
  return executable;
}
