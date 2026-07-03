import { execFile, type ExecFileOptions } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ExecFileResult = { stdout: string; stderr: string };

const BATCH_SCRIPT = /\.(cmd|bat)$/i;
// cmd.exe metacharacters that must be caret-escaped (cross-spawn's set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * `execFile` that also works on Windows for commands that are not real
 * executables: npm-installed CLIs are `.cmd` batch shims there, which
 * `execFile` refuses to spawn (EINVAL) and bare names like "visp" resolve only
 * through PATHEXT lookup (ENOENT otherwise). Such commands are resolved via
 * PATH + PATHEXT and batch scripts are re-run through `cmd.exe /d /s /c` with
 * every argument individually escaped — no shell interpolation of caller
 * input. POSIX behavior is exactly `promisify(execFile)`, and error shapes
 * (`code`, `stdout`, `killed`, `signal`) are preserved so existing degradation
 * paths keep working; a command that resolves to nothing still throws ENOENT.
 */
export async function execFileCrossPlatform(
  file: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<ExecFileResult> {
  if (process.platform !== "win32") {
    return execFileAsync(file, args, options) as Promise<ExecFileResult>;
  }
  if (BATCH_SCRIPT.test(file)) {
    return execViaCmd(file, args, options);
  }
  try {
    return (await execFileAsync(file, args, options)) as ExecFileResult;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: bare name that may still resolve via PATHEXT (e.g. visp.cmd).
    // EINVAL: Node refusing a batch script without a shell (CVE-2024-27980).
    if (code !== "ENOENT" && code !== "EINVAL") {
      throw error;
    }
    const resolved = await resolveViaPathExt(file, options.cwd?.toString());
    if (resolved === null) {
      throw error;
    }
    if (BATCH_SCRIPT.test(resolved)) {
      return execViaCmd(resolved, args, options);
    }
    return (await execFileAsync(resolved, args, options)) as ExecFileResult;
  }
}

/**
 * Mirror the PATH + PATHEXT lookup CreateProcess skips when Node spawns
 * directly: for each candidate directory (or the literal path when the
 * command already contains a separator), probe every executable extension.
 */
async function resolveViaPathExt(file: string, cwd: string | undefined): Promise<string | null> {
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const lower = file.toLowerCase();
  const suffixes = exts.some((ext) => lower.endsWith(ext.toLowerCase())) ? [""] : exts;
  const bases = /[\\/]/.test(file)
    ? [resolvePath(cwd ?? process.cwd(), file)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, file));
  for (const base of bases) {
    for (const suffix of suffixes) {
      const candidate = base + suffix;
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep probing
      }
    }
  }
  return null;
}

async function execViaCmd(
  file: string,
  args: string[],
  options: ExecFileOptions
): Promise<ExecFileResult> {
  // cmd.exe parses the line a second time when the target is a batch script,
  // so arguments need their meta characters escaped twice (cross-spawn rule).
  const doubleEscape = BATCH_SCRIPT.test(file);
  const command = [escapeCommand(file), ...args.map((arg) => escapeArgument(arg, doubleEscape))].join(" ");
  return (await execFileAsync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `"${command}"`],
    { ...options, windowsVerbatimArguments: true }
  )) as ExecFileResult;
}

function escapeCommand(file: string): string {
  // Caret-escaping (which covers spaces) keeps the command outside quote
  // context so the escapes stay active; quoting it would neutralize carets.
  return file.replace(CMD_META, "^$1");
}

function escapeArgument(arg: string, doubleEscape: boolean): string {
  let result = arg.replace(/(\\*)"/g, '$1$1\\"');
  result = result.replace(/(\\*)$/, "$1$1");
  result = `"${result}"`.replace(CMD_META, "^$1");
  return doubleEscape ? result.replace(CMD_META, "^$1") : result;
}
