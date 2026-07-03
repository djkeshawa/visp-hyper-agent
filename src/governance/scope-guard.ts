import { execFileCrossPlatform } from "../core/exec.js";
import { isBlockedPath } from "./blocked-files.js";

export type ScopeViolation = { file: string; rule: "blocked-path" | "outside-allowed" };

/**
 * Mechanical scope check. The blocked-path rule always applies; the
 * outside-allowed rule applies only when `allowedFiles` is a non-empty array.
 * Matching semantics are identical to the original local-evidence rules: a
 * blocked path is exact-or-`<pattern>/`-prefix (with `.*` glob support via
 * {@link isBlockedPath}); an allowed entry matches on exact, `<entry>/` prefix,
 * or trailing-slash prefix.
 */
export function checkScope(
  changedFiles: string[],
  input: { allowedFiles?: string[]; blockedPaths: string[] }
): ScopeViolation[] {
  const allowed = input.allowedFiles;
  const hasAllowList = Array.isArray(allowed) && allowed.length > 0;
  const violations: ScopeViolation[] = [];

  for (const file of changedFiles) {
    if (isBlockedPath(file, input.blockedPaths)) {
      violations.push({ file, rule: "blocked-path" });
      continue;
    }
    // .visp/ holds workflow-owned metadata that visp-hyper and the kit write
    // as a byproduct of orchestration (handoffs, telemetry, task graphs); it
    // is never part of a task's implementation scope, so the allow-list rule
    // does not apply to it. Blocked paths above still do.
    if (file.startsWith(".visp/")) {
      continue;
    }
    if (hasAllowList && !matchesAllowed(file, allowed)) {
      violations.push({ file, rule: "outside-allowed" });
    }
  }

  return violations;
}

function matchesAllowed(file: string, allowed: string[]): boolean {
  return allowed.some((entry) => {
    if (entry === file) {
      return true;
    }
    if (entry.endsWith("/")) {
      return file.startsWith(entry);
    }
    return file.startsWith(`${entry}/`);
  });
}

export type ChangedFilesMode =
  | { mode: "staged" }
  | { mode: "all" }
  | { mode: "base"; baseRef: string };

/**
 * Collect changed file paths from git. Never throws: a non-repo, bad ref, or any
 * other git failure resolves to `{ files: [], warnings: [...] }` so callers can
 * degrade open.
 *
 * - `staged`: `git diff --name-only --cached`
 * - `all`: union of working-tree (`git diff --name-only`), staged, and untracked changes
 * - `base`: `git diff --name-only <baseRef>...HEAD`
 */
export async function collectChangedFiles(
  projectPath: string,
  mode: ChangedFilesMode
): Promise<{ files: string[]; warnings: string[] }> {
  try {
    if (mode.mode === "staged") {
      const { stdout } = await execFileCrossPlatform("git", ["diff", "--name-only", "--cached"], {
        cwd: projectPath
      });
      return { files: splitNames(stdout), warnings: [] };
    }

    if (mode.mode === "all") {
      const [unstaged, staged, untracked] = await Promise.all([
        execFileCrossPlatform("git", ["diff", "--name-only"], { cwd: projectPath }),
        execFileCrossPlatform("git", ["diff", "--name-only", "--cached"], { cwd: projectPath }),
        execFileCrossPlatform("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectPath })
      ]);
      const files = [...splitNames(unstaged.stdout), ...splitNames(staged.stdout), ...splitNames(untracked.stdout)];
      return { files: [...new Set(files)], warnings: [] };
    }

    const { stdout } = await execFileCrossPlatform(
      "git",
      ["diff", "--name-only", `${mode.baseRef}...HEAD`],
      { cwd: projectPath }
    );
    return { files: splitNames(stdout), warnings: [] };
  } catch {
    return { files: [], warnings: ["git diff could not be read; scope check was skipped"] };
  }
}

function splitNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
