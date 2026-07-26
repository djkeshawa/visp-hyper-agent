import { execFileResolved } from "../core/executable-resolver.js";
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
      const { stdout } = await execFileResolved("git", ["diff", "--name-only", "--cached"], {
        cwd: projectPath
      });
      return { files: splitNames(stdout), warnings: [] };
    }

    if (mode.mode === "all") {
      const [unstaged, staged, untracked] = await Promise.all([
        execFileResolved("git", ["diff", "--name-only"], { cwd: projectPath }),
        execFileResolved("git", ["diff", "--name-only", "--cached"], { cwd: projectPath }),
        execFileResolved("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectPath })
      ]);
      const files = [...splitNames(unstaged.stdout), ...splitNames(staged.stdout), ...splitNames(untracked.stdout)];
      return { files: [...new Set(files)], warnings: [] };
    }

    // A ref beginning with `-` would be parsed by git as an option rather than
    // a revision, so it is rejected before it reaches the argument vector. The
    // trailing `--` then pins the remainder as "no pathspecs", so a ref that
    // happens to match a filename cannot be reinterpreted as a path.
    if (mode.baseRef.startsWith("-")) {
      return {
        files: [],
        warnings: [`base ref "${mode.baseRef}" is not a valid revision; scope check was skipped`]
      };
    }
    const { stdout } = await execFileResolved(
      "git",
      ["diff", "--name-only", `${mode.baseRef}...HEAD`, "--"],
      { cwd: projectPath }
    );
    return { files: splitNames(stdout), warnings: [] };
  } catch {
    return { files: [], warnings: ["git diff could not be read; scope check was skipped"] };
  }
}

/** Tracked working-tree and staged changes only (excludes untracked generated artifacts). */
export async function collectTrackedChangedFiles(projectPath: string): Promise<Set<string> | null> {
  try {
    const [unstaged, staged] = await Promise.all([
      execFileResolved("git", ["diff", "--name-only"], { cwd: projectPath }),
      execFileResolved("git", ["diff", "--name-only", "--cached"], { cwd: projectPath })
    ]);
    return new Set([...splitNames(unstaged.stdout), ...splitNames(staged.stdout)]);
  } catch {
    return null;
  }
}

function splitNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
