import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { execFileResolved } from "../core/executable-resolver.js";
import type { ValidationCommandRunner, ValidationResult } from "../core/types.js";

/**
 * Captured output ceiling per validation command. Node's `execFile` default is
 * 1 MB, which a verbose test reporter or a chatty build exceeds routinely — and
 * an overflow KILLS the child, so a suite that was on its way to exiting zero
 * never gets to. The limit is raised well past any realistic reporter, and an
 * overflow that still happens is reported as inconclusive rather than failed
 * (see {@link ProjectValidationRunner.run}).
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

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

      const parts = command.split(/\s+/);
      const [first, ...rest] = parts;

      try {
        const { stdout, stderr } = await execFileResolved(first!, rest, {
          cwd: projectPath,
          timeout: this.timeoutMs,
          maxBuffer: MAX_OUTPUT_BYTES
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
        const rawOut = (failure.stdout ?? "") + (failure.stderr ?? "");
        const output = rawOut.trim().slice(0, 4000);

        // ONLY a numeric `code` is a real exit status. Everything else means the
        // process was terminated before it could report one — never spawned
        // (ENOENT/EINVAL), killed for exceeding maxBuffer, or killed on timeout.
        // Reporting those as "exit 1" invents a verdict the command never gave
        // and turns a green suite into failed evidence, which then quarantines
        // the task class and injects remediation. Record exitCode null + a
        // spawnError so evidence says "could not be run": still fails closed,
        // but honestly.
        if (typeof failure.code === "number") {
          results.push({ command, exitCode: failure.code, output });
          continue;
        }

        const reason = describeTermination(first!, failure, this.timeoutMs);
        results.push({
          command,
          exitCode: null,
          output: output || `command could not be run: ${reason}`,
          spawnError: reason
        });
      }
    }

    return results;
  }
}

/**
 * Human-readable reason a validation command ended without an exit status. Kept
 * specific per cause so a checkpoint finding tells the agent what to actually
 * change: raise the reporter's verbosity down, split a slow suite, or install a
 * missing binary.
 */
function describeTermination(
  binary: string,
  failure: { code?: string | number; killed?: boolean; signal?: string },
  timeoutMs: number
): string {
  const code = typeof failure.code === "string" ? failure.code : undefined;

  if (code === "ENOENT" || code === "EINVAL") {
    return `${binary} could not be spawned (${code})`;
  }
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `${binary} produced more than ${MAX_OUTPUT_BYTES} bytes of output and was terminated before it could exit`;
  }
  if (failure.killed === true) {
    return `${binary} was terminated after the ${timeoutMs}ms validation timeout`;
  }
  if (failure.signal) {
    return `${binary} was killed by signal ${failure.signal}`;
  }
  return `${binary} ended without an exit status${code ? ` (${code})` : ""}`;
}
