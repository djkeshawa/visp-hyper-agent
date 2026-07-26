import { isAbsolute, resolve } from "node:path";
import { execFileResolved } from "../core/executable-resolver.js";

/**
 * Resolve Git's effective hooks directory. `git rev-parse --git-path hooks`
 * handles ordinary repositories, linked worktrees, and configured hooksPath
 * without assuming `.git` is a directory.
 */
export async function resolveGitHooksDirectory(projectPath: string): Promise<string | null> {
  try {
    const result = await execFileResolved(
      "git",
      ["rev-parse", "--git-path", "hooks"],
      { cwd: projectPath, timeout: 5_000 }
    );
    const path = result.stdout.trim();
    if (!path) return null;
    return isAbsolute(path) ? path : resolve(projectPath, path);
  } catch {
    return null;
  }
}
