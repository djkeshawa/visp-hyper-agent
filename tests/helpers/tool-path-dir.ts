import { execFile } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";

/**
 * A temp directory exposing exactly the named tools, so tests can restrict
 * PATH to hide any installed `visp` while keeping git/node/npm working. On
 * POSIX each tool is a symlink to its `which`-resolved binary; on Windows a
 * `<tool>.cmd` wrapper around the `where`-resolved target (production
 * subprocess calls go through execFileCrossPlatform, which runs `.cmd`
 * wrappers via cmd.exe). `node` always maps to the running executable.
 * Tools listed in `optional` are skipped silently when absent.
 */
export async function createToolOnlyPathDir(
  tools: string[],
  options: { optional?: string[] } = {}
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "visp-nokit-"));
  const optional = new Set(options.optional ?? []);
  for (const tool of tools) {
    try {
      const target = tool === "node" ? process.execPath : await resolveTool(tool);
      await exposeTool(dir, tool, target);
    } catch (error) {
      if (!optional.has(tool)) {
        throw error;
      }
      // Tool absent in the host environment; tests relying on it will surface it.
    }
  }
  return dir;
}

async function resolveTool(tool: string): Promise<string> {
  if (isWindows) {
    const { stdout } = await execFileAsync("where", [tool]);
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const executable = lines.find((line) => /\.(exe|cmd|bat|com)$/i.test(line)) ?? lines[0];
    if (!executable) {
      throw new Error(`where found no executable for ${tool}`);
    }
    return executable;
  }
  const { stdout } = await execFileAsync("which", [tool]);
  return stdout.trim();
}

async function exposeTool(dir: string, tool: string, target: string): Promise<void> {
  if (isWindows) {
    // `call` (not chaining) so wrapped .cmd targets return their exit code.
    await writeFile(join(dir, `${tool}.cmd`), `@call "${target}" %*\r\n@exit /b %errorlevel%\r\n`, "utf8");
    return;
  }
  await symlink(target, join(dir, tool));
}
