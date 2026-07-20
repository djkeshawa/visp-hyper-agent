import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileResolved } from "../core/executable-resolver.js";
import { resolveProjectFile } from "../core/project-path.js";
import type { GitBaseline, GitSettledPathState } from "../core/types.js";
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
  | { mode: "base"; baseRef: string }
  | { mode: "baseline"; baseline: GitBaseline };

export type GitEvidenceInventory = {
  /** False means at least one required Git layer was unavailable. */
  ok: boolean;
  /** Authoritative, sorted union. Empty whenever `ok` is false. */
  files: string[];
  /** Git failures only; retained for compatibility with existing callers. */
  warnings: string[];
  committed: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
};

export type GitPathStateResult =
  | { ok: true; states: Record<string, GitSettledPathState> }
  | { ok: false; warning: string };

/** Hyper-owned generated paths are not attributable user changes. */
export function isHyperManagedPath(file: string): boolean {
  return (
    file === ".visp/hyper" ||
    file.startsWith(".visp/hyper/") ||
    file === ".visp/prompts/visp-hyper-handoff.prompt.md"
  );
}

export function attributableChangedFiles(files: readonly string[]): string[] {
  return files.filter((file) => !isHyperManagedPath(file));
}

/**
 * Collect changed file paths from Git. Never throws. A non-repo, bad ref, or
 * failed layer returns `ok: false`, an empty authoritative union, and a warning
 * so enforcement callers cannot mistake unavailable evidence for an empty diff.
 *
 * - `staged`: `git diff --name-only --cached`
 * - `all`: union of staged, unstaged, and nonignored untracked changes
 * - `base`: committed `<baseRef>...HEAD` plus all three working-tree layers
 * - `baseline`: exact session-baseline-to-HEAD changes plus all working-tree layers
 */
export async function collectChangedFiles(
  projectPath: string,
  mode: ChangedFilesMode
): Promise<GitEvidenceInventory> {
  if (mode.mode === "staged") {
    const staged = await collectNames(
      projectPath,
      ["diff", "--name-only", "--no-renames", "-z", "--cached", "--"],
      "staged changes"
    );
    return inventory({ staged });
  }

  const headBefore = mode.mode === "base" || mode.mode === "baseline"
    ? await readHeadToken(projectPath)
    : null;
  if (headBefore && !headBefore.ok) {
    const warning = mode.mode === "baseline" && mode.baseline.kind === "unborn"
      ? `unborn Git baseline could not be verified: ${headBefore.warning}`
      : headBefore.warning;
    return inventory({ committed: failedLayer(warning) });
  }

  const [staged, unstaged, untracked] = await Promise.all([
    collectNames(
      projectPath,
      ["diff", "--name-only", "--no-renames", "-z", "--cached", "--"],
      "staged changes"
    ),
    collectNames(
      projectPath,
      ["diff", "--name-only", "--no-renames", "-z", "--"],
      "unstaged changes"
    ),
    collectNames(
      projectPath,
      ["ls-files", "--others", "--exclude-standard", "-z", "--"],
      "untracked files"
    )
  ]);

  if (mode.mode === "all") {
    return inventory({ staged, unstaged, untracked });
  }

  let committed: LayerResult;
  if (mode.mode === "base") {
    committed = validRevisionInput(mode.baseRef)
      ? await collectNames(
          projectPath,
          [
            "diff",
            "--name-only",
            "--no-renames",
            "-z",
            `${mode.baseRef}...HEAD`,
            "--"
          ],
          `committed changes from ${mode.baseRef}`
        )
      : failedLayer("base ref must be a non-empty, trimmed Git revision that does not start with '-'");
  } else if (mode.baseline.kind === "unavailable") {
    committed = failedLayer(`recorded Git baseline is unavailable: ${mode.baseline.reason}`);
  } else if (mode.baseline.kind === "unborn") {
    committed = await collectCommittedFromUnbornBaseline(projectPath);
  } else if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(mode.baseline.revision)) {
    committed = failedLayer("recorded Git baseline commit is not an exact 40- or 64-character object id");
  } else {
    committed = await collectNames(
      projectPath,
      [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        mode.baseline.revision,
        "HEAD",
        "--"
      ],
      `committed changes from ${mode.baseline.revision}`
    );
  }

  let result = inventory({ committed, staged, unstaged, untracked });
  if (mode.mode === "baseline" && mode.baseline.kind !== "unavailable") {
    result = await applySettledPaths(projectPath, result, mode.baseline.settledPaths);
  }

  const headAfter = await readHeadToken(projectPath);
  if (!headAfter.ok) {
    return incompleteInventory(result, headAfter.warning);
  }
  if (headBefore?.ok && headBefore.token !== headAfter.token) {
    return incompleteInventory(
      result,
      `Git HEAD changed while evidence was collected (${headBefore.token} -> ${headAfter.token})`
    );
  }
  return result;
}

/** Tracked working-tree and staged changes only (excludes untracked generated artifacts). */
export async function collectTrackedChangedFiles(projectPath: string): Promise<Set<string> | null> {
  const changed = await collectChangedFiles(projectPath, { mode: "all" });
  if (!changed.ok) {
    return null;
  }
  return new Set([...changed.staged, ...changed.unstaged]);
}

type LayerResult = { files: string[]; warning?: string };

type HeadTokenResult =
  | { ok: true; token: string }
  | { ok: false; warning: string };

async function readHeadToken(projectPath: string): Promise<HeadTokenResult> {
  try {
    const { stdout } = await execFileResolved(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: projectPath, timeout: 10_000 }
    );
    const revision = stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(revision)) {
      return { ok: false, warning: "Git returned an invalid HEAD commit id" };
    }
    return { ok: true, token: `commit:${revision}` };
  } catch {
    // A missing commit is legitimate only for an exact, still-missing symbolic
    // branch ref. Detached, dangling, and non-commit HEADs remain errors.
  }

  let headRef: string;
  try {
    const { stdout } = await execFileResolved("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: projectPath,
      timeout: 10_000
    });
    headRef = stdout.trim();
    if (headRef.length === 0) {
      return { ok: false, warning: "Git symbolic HEAD target is empty" };
    }
  } catch (error) {
    return { ok: false, warning: `Git HEAD could not be resolved: ${gitFailureReason(error)}` };
  }

  try {
    await execFileResolved("git", ["show-ref", "--verify", "--quiet", headRef], {
      cwd: projectPath,
      timeout: 10_000
    });
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return { ok: true, token: `unborn:${headRef}` };
    }
    return {
      ok: false,
      warning: `Git symbolic HEAD target could not be verified: ${gitFailureReason(error)}`
    };
  }
  return {
    ok: false,
    warning: `Git symbolic HEAD target ${headRef} exists but does not resolve to a commit`
  };
}

/** Capture exact worktree and index state for paths already reviewed at a task boundary. */
export async function captureGitPathStates(
  projectPath: string,
  files: readonly string[]
): Promise<GitPathStateResult> {
  const entries = await Promise.all(
    sortedUnique([...files]).map(async (file) => {
      try {
        const [worktree, index] = await Promise.all([
          captureWorktreeState(projectPath, file),
          captureIndexState(projectPath, file)
        ]);
        return {
          ok: true as const,
          file,
          state: {
            exists: worktree.exists,
            worktreeHash: worktree.hash,
            indexHash: index.hash,
            indexMatchesWorktree: index.matchesWorktree
          } satisfies GitSettledPathState
        };
      } catch (error) {
        return {
          ok: false as const,
          warning: `Git path state for ${printablePath(file)} could not be captured: ${gitFailureReason(error)}`
        };
      }
    })
  );
  const failure = entries.find((entry) => !entry.ok);
  if (failure && !failure.ok) {
    return { ok: false, warning: failure.warning };
  }
  return {
    ok: true,
    states: Object.fromEntries(
      entries
        .filter((entry): entry is Extract<(typeof entries)[number], { ok: true }> => entry.ok)
        .map((entry) => [entry.file, entry.state])
    )
  };
}

async function captureWorktreeState(
  projectPath: string,
  file: string
): Promise<{ exists: boolean; hash: string | null }> {
  const resolved = await resolveProjectFile(projectPath, file, { mode: "write" });
  if (resolved.logicalPath !== file) {
    throw new Error("Git path is not canonical for project-file resolution");
  }
  if (!resolved.exists) {
    return { exists: false, hash: null };
  }

  const lexicalPath = join(projectPath, ...resolved.logicalPath.split("/"));
  const info = await lstat(lexicalPath);
  const hash = createHash("sha256");
  if (info.isSymbolicLink()) {
    // resolveProjectFile already proved that the target is a regular in-project
    // file. Hash the link itself so retargeting is still observable.
    hash.update("symlink\0");
    hash.update(await readlink(lexicalPath));
  } else if (info.isFile()) {
    hash.update(`file\0${(info.mode & 0o111) === 0 ? "nonexec" : "exec"}\0`);
    hash.update(await readFile(resolved.absolutePath));
  } else {
    throw new Error("path is not a regular file or safe symlink");
  }
  return { exists: true, hash: hash.digest("hex") };
}

async function captureIndexState(
  projectPath: string,
  file: string
): Promise<{ hash: string | null; matchesWorktree: boolean }> {
  const { stdout } = await execFileResolved(
    "git",
    ["ls-files", "--stage", "-z", "--", file],
    { cwd: projectPath, timeout: 10_000 }
  );
  if (stdout.length === 0) {
    return { hash: null, matchesWorktree: false };
  }
  let matchesWorktree: boolean;
  try {
    await execFileResolved(
      "git",
      ["diff", "--quiet", "--no-ext-diff", "--", file],
      { cwd: projectPath, timeout: 10_000 }
    );
    matchesWorktree = true;
  } catch (error) {
    if (gitExitCode(error) !== 1) {
      throw error;
    }
    matchesWorktree = false;
  }
  return {
    hash: createHash("sha256").update(stdout).digest("hex"),
    matchesWorktree
  };
}

async function applySettledPaths(
  projectPath: string,
  evidence: GitEvidenceInventory,
  settledPaths: Record<string, GitSettledPathState> | undefined
): Promise<GitEvidenceInventory> {
  const settledEntries = Object.entries(settledPaths ?? {});
  if (!evidence.ok || settledEntries.length === 0) {
    return evidence;
  }

  const current = await captureGitPathStates(
    projectPath,
    settledEntries.map(([file]) => file)
  );
  if (!current.ok) {
    return incompleteInventory(evidence, current.warning);
  }

  const changedSettled = new Set(
    settledEntries
      .filter(([file, previous]) => !samePathState(previous, current.states[file]))
      .map(([file]) => file)
  );
  const retain = (file: string): boolean =>
    !Object.hasOwn(settledPaths ?? {}, file) || changedSettled.has(file);
  const committed = evidence.committed.filter(retain);
  const staged = evidence.staged.filter(retain);
  let unstaged = evidence.unstaged.filter(retain);
  const untracked = evidence.untracked.filter(retain);
  const rawRetained = new Set([...committed, ...staged, ...unstaged, ...untracked]);
  unstaged = sortedUnique([
    ...unstaged,
    ...[...changedSettled].filter((file) => !rawRetained.has(file))
  ]);
  return inventory({
    committed: { files: committed },
    staged: { files: staged },
    unstaged: { files: unstaged },
    untracked: { files: untracked }
  });
}

function samePathState(
  left: GitSettledPathState,
  right: GitSettledPathState | undefined
): boolean {
  return (
    right !== undefined &&
    left.exists === right.exists &&
    left.worktreeHash === right.worktreeHash &&
    (left.indexHash === right.indexHash || right.indexMatchesWorktree)
  );
}

function incompleteInventory(
  evidence: GitEvidenceInventory,
  warning: string
): GitEvidenceInventory {
  return {
    ...evidence,
    ok: false,
    files: [],
    warnings: [...evidence.warnings, warning]
  };
}

function printablePath(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}

async function collectNames(
  projectPath: string,
  args: string[],
  label: string
): Promise<LayerResult> {
  try {
    const { stdout } = await execFileResolved("git", args, {
      cwd: projectPath,
      timeout: 10_000
    });
    return { files: splitNullNames(stdout) };
  } catch (error) {
    return failedLayer(`${label} could not be read: ${gitFailureReason(error)}`);
  }
}

async function collectCommittedFromUnbornBaseline(projectPath: string): Promise<LayerResult> {
  try {
    await execFileResolved("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: projectPath,
      timeout: 10_000
    });
  } catch {
    return collectFromStillUnbornHead(projectPath);
  }

  return collectNames(
    projectPath,
    ["ls-tree", "-r", "--full-tree", "--name-only", "-z", "HEAD"],
    "committed changes from the unborn baseline"
  );
}

async function collectFromStillUnbornHead(projectPath: string): Promise<LayerResult> {
  let headRef: string;
  try {
    const { stdout } = await execFileResolved("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: projectPath,
      timeout: 10_000
    });
    headRef = stdout.trim();
    if (headRef.length === 0) {
      return failedLayer("unborn Git baseline has an empty symbolic HEAD target");
    }
  } catch (error) {
    return failedLayer(`unborn Git baseline could not be verified: ${gitFailureReason(error)}`);
  }

  try {
    await execFileResolved("git", ["show-ref", "--verify", "--quiet", headRef], {
      cwd: projectPath,
      timeout: 10_000
    });
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return { files: [] };
    }
    return failedLayer(`unborn Git baseline ref could not be verified: ${gitFailureReason(error)}`);
  }

  return failedLayer(
    `unborn Git baseline ref ${headRef} exists but HEAD does not resolve to a commit`
  );
}

function inventory(input: {
  committed?: LayerResult;
  staged?: LayerResult;
  unstaged?: LayerResult;
  untracked?: LayerResult;
}): GitEvidenceInventory {
  const committed = sortedUnique(input.committed?.files ?? []);
  const staged = sortedUnique(input.staged?.files ?? []);
  const unstaged = sortedUnique(input.unstaged?.files ?? []);
  const untracked = sortedUnique(input.untracked?.files ?? []);
  const warnings = [
    input.committed?.warning,
    input.staged?.warning,
    input.unstaged?.warning,
    input.untracked?.warning
  ].filter((warning): warning is string => Boolean(warning));
  return {
    ok: warnings.length === 0,
    files: warnings.length === 0
      ? sortedUnique([...committed, ...staged, ...unstaged, ...untracked])
      : [],
    warnings,
    committed,
    staged,
    unstaged,
    untracked
  };
}

function failedLayer(warning: string): LayerResult {
  return { files: [], warning };
}

function splitNullNames(stdout: string): string[] {
  return stdout.split("\0").filter((file) => file.length > 0);
}

function sortedUnique(files: string[]): string[] {
  return [...new Set(files)].sort();
}

function validRevisionInput(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.startsWith("-") && !/[\0\r\n]/u.test(value);
}

function gitExitCode(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

function gitFailureReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/gu, " ").trim().slice(0, 240) || "Git command failed";
}
