import { execFileCrossPlatform } from "./exec.js";
import type { BranchSessionLocator } from "./types.js";

export class GitBranchSessionLocator implements BranchSessionLocator {
  async currentBranch(projectPath: string): Promise<string | null> {
    try {
      const { stdout } = await execFileCrossPlatform(
        "git",
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: projectPath, timeout: 5000 }
      );
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  sessionKey(projectPath: string, branch: string | null): string {
    if (!branch) {
      return projectPath;
    }
    return `${projectPath}#${branch}`;
  }
}
