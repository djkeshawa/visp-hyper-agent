import { execFileResolved } from "./executable-resolver.js";

/**
 * Outcome of one git invocation. The failure arm carries a human-readable
 * `reason` rather than an Error so callers can fold it straight into a warning
 * list or an evidence finding.
 */
export type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Run a read-only git command and NEVER throw. Every git surface in this repo
 * is optional context — the working tree may not be a repository, may have no
 * commits yet (so `HEAD` does not resolve), or may be mid-rebase. Those are all
 * ordinary states a project can be in, not crashes, and a raw Node stack trace
 * is the one output shape the coding agents that consume our delimited blocks
 * cannot parse.
 *
 * Callers decide what a failure means: `guard` and `review` degrade to an
 * explicit inconclusive status, checkpoint evidence falls back to a warning.
 * The one thing no caller may do is treat "git could not answer" as "nothing
 * changed", so the failure arm is a distinct shape and not an empty string.
 */
export async function gitOutput(
  projectPath: string,
  args: string[],
  options: { timeoutMs?: number } = {}
): Promise<GitResult> {
  try {
    const { stdout } = await execFileResolved("git", args, {
      cwd: projectPath,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES
    });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, reason: gitFailureReason(args, error) };
  }
}

/** Split git's newline-delimited path output into trimmed, non-empty entries. */
export function gitLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Collapse git's multi-line diagnostics into one line naming the command that
 * failed, so it can sit inside a single-line warning or block field.
 */
function gitFailureReason(args: string[], error: unknown): string {
  const failure = error as { stderr?: string; message?: string };
  const detail = (failure.stderr ?? failure.message ?? String(error))
    .replace(/\s+/gu, " ")
    .trim();
  return `git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`;
}
