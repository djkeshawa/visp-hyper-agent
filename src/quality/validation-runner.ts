import { execFile } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ValidationCommandRunner } from "../core/types.js";

const execFileAsync = promisify(execFile);

export class ProjectValidationRunner implements ValidationCommandRunner {
  private readonly timeoutMs: number;
  private readonly kitCommands: string[] | undefined;

  constructor(options?: { timeoutMs?: number; kitCommands?: string[] }) {
    this.timeoutMs = options?.timeoutMs ?? 120_000;
    this.kitCommands = options?.kitCommands;
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
      return [];
    }

    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("scripts" in pkg) ||
      typeof (pkg as Record<string, unknown>).scripts !== "object" ||
      (pkg as Record<string, unknown>).scripts === null
    ) {
      return [];
    }

    const scripts = (pkg as Record<string, unknown>).scripts as Record<string, unknown>;
    const ORDERED = ["test", "typecheck", "build", "check"] as const;
    const result: string[] = [];
    for (const name of ORDERED) {
      if (name in scripts) {
        result.push(`${pm} run ${name}`);
      }
    }
    return result;
  }

  async run(
    projectPath: string,
    commands: string[]
  ): Promise<Array<{ command: string; exitCode: number; output: string }>> {
    const allowlist = await this.detect(projectPath);
    const results: Array<{ command: string; exitCode: number; output: string }> = [];

    for (const command of commands) {
      if (!allowlist.includes(command)) {
        results.push({ command, exitCode: -1, output: "command not in detected allowlist" });
        continue;
      }

      const parts = command.split(/\s+/);
      const [first, ...rest] = parts;

      try {
        const { stdout, stderr } = await execFileAsync(first!, rest, {
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
        const exitCode = typeof failure.code === "number" ? failure.code : 1;
        const rawOut = (failure.stdout ?? "") + (failure.stderr ?? "");
        const output = rawOut.trim().slice(0, 4000);
        results.push({ command, exitCode, output });
      }
    }

    return results;
  }
}
