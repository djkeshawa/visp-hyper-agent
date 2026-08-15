/**
 * Running one Visp Kit command and making sense of what came back.
 *
 * Everything here is below the bridge's vocabulary: how long a command may
 * take, how argv is built, how a spawn failure is told apart from a non-zero
 * exit, and how stdout becomes a validated value. The bridge above decides
 * WHICH command to run; this decides what running one means.
 */

import { createHash } from "node:crypto";
import type { ZodType, ZodTypeDef } from "zod";
import { execFileResolved } from "../core/executable-resolver.js";

// Schemas with `.transform()` have a different input than output type; allow any input.
export type OutputSchema<T> = ZodType<T, ZodTypeDef, unknown>;

// Kit's verification runner allows 120s per validation command and may run several
// inside one process, so the 10s default kills `visp verify` on any repository with
// a real test suite — the checkpoint then reports INCONCLUSIVE forever. Long-running
// Kit commands get their own budget; status, next, gate and the integration contract
// stay at the default because `guard` runs on the PreToolUse hot path, where a hung
// Kit should surface in seconds rather than stalling every edit.
export const KIT_DEFAULT_TIMEOUT_MS = 10_000;
export const KIT_LONG_COMMAND_TIMEOUT_MS = 600_000;

/**
 * Which budget a Kit command gets.
 *
 * `configuredMs` is whatever the caller passed to the bridge constructor. An
 * explicit value is a deliberate choice and wins for every command — tests rely on
 * this to force fast timeouts. Only when the bridge fell back to the default does a
 * long-running command get the larger budget.
 *
 * Returns `undefined` to mean "use the bridge's own timeout".
 */
export function resolveKitCommandTimeout(input: {
  configuredMs: number | undefined;
  longRunning: boolean;
}): number | undefined {
  if (input.configuredMs !== undefined) return undefined;
  return input.longRunning ? KIT_LONG_COMMAND_TIMEOUT_MS : undefined;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
}

export type CommandFailureCode = "binary_not_found" | "command_timeout" | "command_failed";

export type CommandOutcome =
  | { ok: true; value: RunResult }
  | { ok: false; reasonCode: CommandFailureCode; reason: string };

/**
 * Split a command string into argv, honouring double quotes.
 *
 * This is deliberately NOT a shell parser: it understands quoting and nothing
 * else — no expansion, no substitution, no operators. Anything resembling shell
 * syntax is refused downstream rather than interpreted here.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;

  let escaped = false;

  for (const character of command.trim()) {
    // A backslash-escaped quote is literal content, not a delimiter. Without
    // this, a goal round-tripped through JSON.stringify loses its own quotes.
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      started = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (started || current.length > 0) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started || current.length > 0) tokens.push(current);
  return tokens;
}

export function withTask(args: string[], taskId?: string): string[] {
  // The real CLI takes the task as a flag; a positional id is parsed as a path.
  return taskId ? [...args, "--task", taskId] : args;
}

/**
 * Centralizes ENOENT (binary missing) and timeout handling. Returns null and
 * records a warning for spawn-level failures; returns the captured stdout and
 * exit code otherwise — even when the exit code is non-zero.
 */
export async function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<CommandOutcome> {
  try {
    const { stdout } = await execFileResolved(binary, args, { cwd, timeout });
    return { ok: true, value: { exitCode: 0, stdout } };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; killed?: boolean; signal?: string };

    if (failure.code === "ENOENT" || failure.code === "EINVAL") {
      return {
        ok: false,
        reasonCode: "binary_not_found",
        reason: `visp binary "${binary}" was not found.`
      };
    }
    if (failure.killed || failure.signal === "SIGTERM") {
      return {
        ok: false,
        reasonCode: "command_timeout",
        reason: `visp ${args.join(" ")} timed out after ${timeout}ms.`
      };
    }

    // Non-zero exit: surface stdout so callers can still parse a JSON body.
    if (typeof failure.code === "number") {
      return {
        ok: true,
        value: { exitCode: failure.code, stdout: failure.stdout ?? "" }
      };
    }

    return {
      ok: false,
      reasonCode: "command_failed",
      reason: `visp ${args.join(" ")} failed: ${failure.message ?? String(error)}`
    };
  }
}

export function parseUnknownJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

export function parseJson<T>(stdout: string, schema: OutputSchema<T>): T | null {
  const data = parseUnknownJson(stdout);
  if (data === undefined) {
    return null;
  }
  return parseData(data, schema);
}

export function parseData<T>(data: unknown, schema: OutputSchema<T>): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
