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

/**
 * Writes an executable Node script that switches on its first argument and
 * prints canned JSON. Pass `binary` to KitCommandBridge / detectVisp directly.
 * On Windows the returned binary is a `visp.cmd` wrapper (shebang scripts are
 * not executable there); both files always exist so PATH-based lookups work
 * on either platform.
 */
export async function createVispShim(spec: ShimSpec): Promise<VispShim> {
  const dir = await mkdtemp(join(tmpdir(), "visp-shim-"));
  const script = join(dir, "visp");
  const binary = process.platform === "win32" ? join(dir, "visp.cmd") : script;
  const argvLogPath = join(dir, "argv.log");

  const source = `#!/usr/bin/env node
"use strict";
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

const body = typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout);
process.stdout.write(body);
process.exit(response.exitCode ?? 0);
`;

  await writeFile(script, source, "utf8");
  await chmod(script, 0o755);
  await writeFile(join(dir, "visp.cmd"), `@node "%~dp0visp" %*\r\n`, "utf8");

  return { binary, argvLogPath };
}
