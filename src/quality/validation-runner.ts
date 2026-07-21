import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFileResolved } from "../core/executable-resolver.js";
import type { ValidationCommandRunner, ValidationResult } from "../core/types.js";

export class ProjectValidationRunner implements ValidationCommandRunner {
  private readonly timeoutMs: number;
  private readonly kitCommands: string[] | undefined;
  private readonly configCommands: string[];

  constructor(options?: { timeoutMs?: number; kitCommands?: string[]; configCommands?: string[] }) {
    this.timeoutMs = options?.timeoutMs ?? 120_000;
    this.kitCommands = options?.kitCommands;
    this.configCommands = options?.configCommands ?? [];
  }

  async detect(projectPath: string): Promise<string[]> {
    // Kit commands win if non-empty
    if (this.kitCommands && this.kitCommands.length > 0) {
      return [...this.kitCommands];
    }

    // Determine package manager
    let pm = "npm";
    try {
      await access(join(projectPath, "pnpm-lock.yaml"));
      pm = "pnpm";
    } catch {
      try {
        await access(join(projectPath, "yarn.lock"));
        pm = "yarn";
      } catch {
        // default npm
      }
    }

    // Read package.json scripts
    let pkg: unknown;
    try {
      const raw = await readFile(join(projectPath, "package.json"), "utf8");
      pkg = JSON.parse(raw);
    } catch {
      return [...this.configCommands];
    }

    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("scripts" in pkg) ||
      typeof (pkg as Record<string, unknown>).scripts !== "object" ||
      (pkg as Record<string, unknown>).scripts === null
    ) {
      return [...this.configCommands];
    }

    const scripts = (pkg as Record<string, unknown>).scripts as Record<string, unknown>;
    const ORDERED = ["test", "typecheck", "build", "check"] as const;
    const result: string[] = [];
    for (const name of ORDERED) {
      if (name in scripts) {
        result.push(`${pm} run ${name}`);
      }
    }
    for (const command of this.configCommands) {
      if (!result.includes(command)) result.push(command);
    }
    return result;
  }

  async run(projectPath: string, commands: string[]): Promise<ValidationResult[]> {
    const allowlist = await this.detect(projectPath);
    const results: ValidationResult[] = [];

    for (const command of commands) {
      if (!allowlist.includes(command)) {
        results.push({ command, exitCode: -1, output: "command not in detected allowlist" });
        continue;
      }

      const parsed = tokenizeCommand(command);
      if (!parsed.ok) {
        results.push({
          command,
          exitCode: -1,
          output: `unsafe validation command: ${parsed.reason}`
        });
        continue;
      }
      const [first, ...rest] = parsed.tokens;

      try {
        const { stdout, stderr } = await execFileResolved(first!, rest, {
          cwd: projectPath,
          timeout: this.timeoutMs
        });
        const output = (stdout + stderr).trim().slice(0, 4000);
        results.push({ command, exitCode: 0, output });
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          code?: string | number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
          signal?: string;
        };

        // A never-spawned command (missing binary / EINVAL batch) is NOT a test
        // failure: record exitCode null + a spawnError so evidence can say
        // "command could not be run" rather than "verify failed".
        if (failure.code === "ENOENT" || failure.code === "EINVAL") {
          results.push({
            command,
            exitCode: null,
            output: `command could not be run: ${first} (${String(failure.code)})`,
            spawnError: `${first} could not be spawned (${String(failure.code)})`
          });
          continue;
        }

        const exitCode = typeof failure.code === "number" ? failure.code : 1;
        const rawOut = (failure.stdout ?? "") + (failure.stderr ?? "");
        const output = rawOut.trim().slice(0, 4000);
        results.push({ command, exitCode, output });
      }
    }

    return results;
  }
}

type TokenizedCommand =
  | { ok: true; tokens: [string, ...string[]] }
  | { ok: false; reason: string };

/**
 * Parse a command into an execFile argument vector. This intentionally supports
 * only quoting and backslash escaping; shell operators and expansion syntax are
 * rejected rather than interpreted.
 */
function tokenizeCommand(command: string): TokenizedCommand {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | null = null;

  const finishToken = (): void => {
    if (tokenStarted) {
      tokens.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (character === "\0" || character === "\n" || character === "\r") {
      return { ok: false, reason: "line breaks and NUL bytes are not allowed" };
    }

    if (quote === "single") {
      if (character === "'") {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = null;
        tokenStarted = true;
        continue;
      }
      if (character === "\\") {
        const next = command[index + 1];
        if (next === '"' || next === "\\") {
          token += next;
          tokenStarted = true;
          index += 1;
          continue;
        }
      }
      if (character === "`" || character === "$") {
        return { ok: false, reason: "shell expansion syntax is not allowed" };
      }
      token += character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      finishToken();
      continue;
    }
    if (character === "'") {
      if (!tokenStarted || token.endsWith("=")) {
        quote = "single";
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      if (!tokenStarted || token.endsWith("=")) {
        quote = "double";
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = command[index + 1];
      if (next === undefined) {
        return { ok: false, reason: "command ends with an incomplete escape" };
      }
      if (/\s/u.test(next) || next === "'" || next === '"' || next === "\\") {
        token += next;
        index += 1;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === ";") {
      const previous = command[index - 1];
      const next = command[index + 1];
      if (
        previous === undefined ||
        next === undefined ||
        /\s/u.test(previous) ||
        /\s/u.test(next)
      ) {
        return { ok: false, reason: "shell operators and expansion syntax are not allowed" };
      }
      token += character;
      tokenStarted = true;
      continue;
    }
    if (/[&|<>`$]/u.test(character)) {
      return { ok: false, reason: "shell operators and expansion syntax are not allowed" };
    }
    token += character;
    tokenStarted = true;
  }

  if (quote !== null) {
    return { ok: false, reason: "command contains an unterminated quote" };
  }
  finishToken();
  if (tokens.length === 0 || !tokens[0]) {
    return { ok: false, reason: "command is empty" };
  }
  return { ok: true, tokens: tokens as [string, ...string[]] };
}
