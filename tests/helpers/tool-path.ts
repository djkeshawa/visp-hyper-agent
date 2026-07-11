import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveExecutable } from "../../src/core/executable-resolver.js";

const execFileAsync = promisify(execFile);
const WINDOWS = process.platform === "win32";

/**
 * Build a throwaway PATH directory that exposes only the named tools (plus the
 * running node), so tests can exercise the kit-less branch without a real
 * `visp` binary leaking in from the host PATH.
 *
 * POSIX: symlink each resolved tool into the dir (historical behavior).
 * win32: an extensionless symlink is neither executable nor privilege-free, so
 * write a `<tool>.cmd` wrapper that forwards to the tool's real absolute path —
 * which the executable-resolver then runs through cmd.exe. `node` is exposed as
 * a copy-free `.cmd` pointing at `process.execPath`.
 */
export async function toolOnlyPath(tools: string[] = ["git"]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-nokit-"));
  const wanted = [...new Set(["node", ...tools])];

  for (const tool of wanted) {
    const target = tool === "node" ? process.execPath : await resolveToolPath(tool);
    if (!target) {
      // Tool absent in the host environment; tests relying on it will surface it.
      continue;
    }
    if (WINDOWS) {
      // Fixed template; no test-controlled string is interpolated into a shell.
      // `call` propagates the target's exit code back to the caller.
      const wrapper = `@echo off\r\ncall "${target}" %*\r\n`;
      await writeFile(join(dir, `${tool}.cmd`), wrapper, "utf8");
    } else {
      await symlink(target, join(dir, tool));
    }
  }

  return dir;
}

async function resolveToolPath(tool: string): Promise<string | null> {
  if (WINDOWS) {
    const resolved = await resolveExecutable(tool);
    if (!resolved) {
      return null;
    }
    // For a batch shim the resolver exposes the real path via `batchPath`; for
    // an exe it returns the path directly.
    return resolved.batchPath ?? resolved.file;
  }
  try {
    const { stdout } = await execFileAsync("which", [tool]);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch {
    return null;
  }
}
