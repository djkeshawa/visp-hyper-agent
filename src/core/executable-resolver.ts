import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * A command name resolved to something `execFile` can actually run on the host
 * platform. On win32, `npm`/`pnpm`/`visp` are `.cmd`/`.bat` shims that
 * `execFile` cannot spawn directly (ENOENT, or EINVAL on newer Node for a
 * direct `.cmd`/`.bat` exec without a shell). A batch resolution is therefore
 * launched through `cmd.exe`.
 *
 * IMPORTANT (no shell interpolation): the caller's args are NOT interpolated
 * into a shell string that could break out. Each arg is individually
 * double-quoted (with embedded `"` doubled per cmd.exe rules) and the whole
 * command is spawned with `windowsVerbatimArguments`, so an arg like `x&y`
 * stays a single literal token and cannot chain a second command. This is the
 * same deterministic quoting Node/cross-spawn apply internally, not a
 * `sh -c "<interpolated>"`.
 */
export interface ResolvedExecutable {
  /** The file to hand to `execFile` (either the resolved path or `cmd.exe`). */
  file: string;
  /**
   * Argument prefix that must precede the caller's own args when this is NOT a
   * batch resolution (always empty for batch — see {@link batchPath}).
   */
  prefixArgs: string[];
  /**
   * When set, the resolution is a `.cmd`/`.bat` run through `cmd.exe`: build the
   * spawn args with {@link buildBatchExecArgs} and spawn with
   * `windowsVerbatimArguments: true`.
   */
  batchPath?: string;
}

const WINDOWS = process.platform === "win32";

/**
 * Default PATHEXT probe order when the environment does not supply one. Batch
 * shims come last so a real `.exe` wins when both exist (e.g. `git`).
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function pathExtensions(): string[] {
  const raw = process.env.PATHEXT ?? DEFAULT_PATHEXT;
  return raw
    .split(";")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isBatch(file: string): boolean {
  const ext = extname(file).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wrap a resolved on-disk path into a {@link ResolvedExecutable}, routing
 * `.cmd`/`.bat` through `cmd.exe` with array args (no interpolation).
 */
function comSpec(): string {
  // Absolute path so a caller that has stripped PATH (e.g. an isolated test
  // PATH) can still spawn cmd.exe.
  return process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
}

function wrapResolvedPath(resolvedPath: string): ResolvedExecutable {
  if (WINDOWS && isBatch(resolvedPath)) {
    return { file: comSpec(), prefixArgs: [], batchPath: resolvedPath };
  }
  return { file: resolvedPath, prefixArgs: [] };
}

/**
 * Quote a single token for cmd.exe: wrap in double quotes and double any
 * embedded double quote. Keeps spaces and shell metacharacters (`&`, `|`, `>`)
 * literal so they cannot chain or redirect.
 */
function quoteForCmd(token: string): string {
  return `"${token.replace(/"/gu, '""')}"`;
}

/**
 * Build the `cmd.exe` arg vector for a batch shim. The whole payload after
 * `/c` is one verbatim string of the form `"<exe>" <args>` wrapped in an outer
 * pair of quotes; `cmd /s` strips exactly that outer pair and runs the rest as
 * already-quoted tokens. Spawn the result with `windowsVerbatimArguments: true`.
 */
export function buildBatchExecArgs(batchPath: string, args: string[]): string[] {
  const line = [quoteForCmd(batchPath), ...args.map(quoteForCmd)].join(" ");
  return ["/d", "/s", "/c", `"${line}"`];
}

/**
 * Resolve `command` to something `execFile` can run.
 *
 * - Non-win32: returned verbatim (execFile already resolves PATH there).
 * - win32 absolute/relative path **with** a known extension: used as-is,
 *   batch shims wrapped through `cmd.exe`.
 * - win32 path **without** an extension, or a bare command name: probed against
 *   PATH (bare names only) and PATHEXT until a real file is found.
 *
 * **This does not tell you whether `command` exists.** On non-win32 it returns
 * a resolution for any name at all, because execFile searches PATH itself — so
 * a `!== null` test here is always true on Linux and macOS, whatever is
 * installed. Use {@link findExecutableOnPath} to ask whether something is
 * there.
 *
 * That distinction is not decoration. This docstring used to end "returns
 * `null` when nothing on disk matches (caller treats this like ENOENT)", which
 * is true only on win32, and four call sites were written against it: doctor's
 * "visp-memory is not installed" branch became unreachable code on POSIX, and
 * `setup` spawned a binary it had just confirmed. Both return a nullable, so
 * the types cannot tell the two questions apart — only this sentence can.
 *
 * Returns `null` on win32 when nothing on disk matches (caller treats this like
 * ENOENT).
 */
export async function resolveExecutable(
  command: string,
  options: { cwd?: string } = {}
): Promise<ResolvedExecutable | null> {
  if (!WINDOWS) {
    return { file: command, prefixArgs: [] };
  }

  const hasPathSeparator = command.includes("/") || command.includes("\\") || isAbsolute(command);

  // An explicit path: probe it directly (and PATHEXT-completed variants).
  if (hasPathSeparator) {
    if (extname(command) && (await isFile(command))) {
      return wrapResolvedPath(command);
    }
    for (const ext of pathExtensions()) {
      const candidate = command + ext;
      if (await isFile(candidate)) {
        return wrapResolvedPath(candidate);
      }
    }
    // A path with an extension that simply does not exist.
    if (extname(command)) {
      return null;
    }
    return null;
  }

  // A bare command name: probe every PATH directory × PATHEXT.
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = pathExtensions();
  for (const dir of dirs) {
    // An exact hit (already carries an extension, e.g. `node.exe`).
    if (extname(command)) {
      const exact = join(dir, command);
      if (await isFile(exact)) {
        return wrapResolvedPath(exact);
      }
      continue;
    }
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      if (await isFile(candidate)) {
        return wrapResolvedPath(candidate);
      }
    }
  }

  return null;
}

/**
 * Where `command` actually lives on PATH, or `null` when it lives nowhere.
 *
 * Deliberately a different question from {@link resolveExecutable}, which
 * answers "what do I hand to execFile" and on POSIX hands back the bare name
 * because execFile searches PATH itself. That answer cannot tell a caller
 * whether the command exists, nor where its package sits on disk — and both
 * gaps shipped: `visp setup` declared visp-dev missing while it sat on PATH,
 * and doctor's "the visp-memory CLI is not installed" branch was unreachable
 * on every non-Windows host.
 */
export async function findExecutableOnPath(command: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  // On POSIX a command name is the filename. On win32 it is the filename minus
  // one of PATHEXT, unless the caller already supplied the extension.
  const extensions = !WINDOWS || extname(command) ? [""] : pathExtensions();

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, command + ext);
      if (await isRunnableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Existence is the whole test on win32, where the execute bit has no meaning;
 * elsewhere a PATH entry that cannot be executed is not a hit.
 */
async function isRunnableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `execFile`-compatible runner that first resolves `command` for the host
 * platform. Preserves execFile's throw-on-failure contract, including a
 * synthetic ENOENT error when nothing resolves. Newer Node throws `EINVAL` for
 * a direct `.cmd`/`.bat` exec without a shell; if that slips through (e.g. a
 * path we treated as a plain exe turns out to be a batch shim), it is retried
 * once through `cmd.exe` so callers see a real ENOENT/exit code, not EINVAL.
 */
export async function execFileResolved(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  const resolved = await resolveExecutable(command, { cwd: options.cwd });
  if (!resolved) {
    const error = new Error(`spawn ${command} ENOENT`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    error.syscall = `spawn ${command}`;
    throw error;
  }

  if (resolved.batchPath) {
    // Batch shim through cmd.exe: verbatim args so our cmd-quoting is preserved.
    return await execFileAsync(resolved.file, buildBatchExecArgs(resolved.batchPath, args), {
      ...options,
      windowsVerbatimArguments: true
    });
  }

  try {
    return await execFileAsync(resolved.file, [...resolved.prefixArgs, ...args], options);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Defense-in-depth: if a direct exec of a batch shim raised EINVAL, retry
    // through cmd.exe with the same verbatim-quoted construction.
    if (err.code === "EINVAL" && WINDOWS && isBatch(resolved.file)) {
      return await execFileAsync(comSpec(), buildBatchExecArgs(resolved.file, args), {
        ...options,
        windowsVerbatimArguments: true
      });
    }
    throw error;
  }
}
