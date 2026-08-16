import { chmod, mkdir, writeFile } from "node:fs/promises";
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
