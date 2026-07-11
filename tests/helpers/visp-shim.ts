import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ShimResponse {
  stdout: object | string;
  exitCode?: number;
}

/**
 * A spec keyed by the first CLI argument (the visp subcommand), e.g.
 * `{ status: { stdout: { ... } }, gate: { stdout: { ... }, exitCode: 1 } }`.
 * Special key "garbage" is not used; emit a string `stdout` to produce non-JSON.
 */
export type ShimSpec = Record<string, ShimResponse>;

export interface VispShim {
  /** Absolute path to the executable shim, pass as `binary` to the bridge. */
  binary: string;
  /** Absolute path to a file the shim appends its received argv to (newline-delimited JSON arrays). */
  argvLogPath: string;
}

const WINDOWS = process.platform === "win32";

/**
 * Writes an executable shim that switches on its first argument and prints
 * canned JSON. Pass `binary` to KitCommandBridge / detectVisp directly.
 *
 * On win32 an extensionless shebang script is not executable, so we emit the
 * logic as a plain `.js` file and a sibling `visp.cmd` wrapper that runs
 * `node <script>` — the shape a real `npm i -g` install produces, which the
 * executable-resolver runs through `cmd.exe`. On POSIX we keep the historical
 * extensionless `#!/usr/bin/env node` script.
 */
export async function createVispShim(spec: ShimSpec): Promise<VispShim> {
  const dir = await mkdtemp(join(tmpdir(), "visp-shim-"));
  const argvLogPath = join(dir, "argv.log");

  const body = `"use strict";
const { appendFileSync } = require("node:fs");

const spec = ${JSON.stringify(spec)};
const argvLogPath = ${JSON.stringify(argvLogPath)};
const args = process.argv.slice(2);

appendFileSync(argvLogPath, JSON.stringify(args) + "\\n");

const subcommand = args.find((arg) => !arg.startsWith("-"));
const response = subcommand ? spec[subcommand] : undefined;

if (!response) {
  process.stderr.write("unknown subcommand: " + String(subcommand) + "\\n");
  process.exit(127);
}

const out = typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout);
process.stdout.write(out);
process.exit(response.exitCode ?? 0);
`;

  if (WINDOWS) {
    // A `.cmd` wrapper is what a real global npm install writes; the resolver
    // runs it through cmd.exe. Point `binary` at the `.cmd` so callers that
    // treat it as an absolute path resolve correctly.
    const scriptPath = join(dir, "visp-shim.js");
    const binary = join(dir, "visp.cmd");
    await writeFile(scriptPath, body, "utf8");
    // `%~dp0` keeps the wrapper location-independent; `%*` forwards args
    // verbatim. No user input is interpolated — this is a fixed template.
    const cmdWrapper = `@echo off\r\nnode "%~dp0visp-shim.js" %*\r\n`;
    await writeFile(binary, cmdWrapper, "utf8");
    return { binary, argvLogPath };
  }

  const binary = join(dir, "visp");
  const script = `#!/usr/bin/env node\n${body}`;
  await writeFile(binary, script, "utf8");
  await chmod(binary, 0o755);

  return { binary, argvLogPath };
}
