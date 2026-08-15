/**
 * Types for `scripts/pair-check.mjs`.
 *
 * The script is plain `.mjs` so `pnpm test:pair` can run it with bare `node`,
 * with no build step and no transpiler between the repository and the check
 * that says whether the repository works. This declaration exists so
 * `tests/pair-check.test.ts` can import the same functions the CLI uses and
 * typecheck against them.
 */

export interface PairSurface {
  /** `ci` only when the environment identifies itself as CI. Never inferred. */
  surface: "ci" | "developer-machine";
  detail: string;
}

export interface CheckoutIdentity {
  path: string;
  version: string | null;
  /** `null` when git could not be consulted — not the same as "no commit". */
  commit: string | null;
  branch: string | null;
  /** `null` when git could not be consulted, so "unknown" never reads as "clean". */
  dirty: boolean | null;
}

/**
 * Hyper carries no declared Kit version range to record: compatibility is an
 * exact pair pinned by commit and artifact hash (visp-kit ADR 0007), so the
 * record names commits and artifacts and nothing semver-shaped.
 */
export type HyperIdentity = CheckoutIdentity;

/** Where the Kit under test came from, and — for npm — exactly which artifact. */
export interface KitOrigin {
  source: "path" | "npm";
  /** The npm spec asked for, e.g. `visp-kit@latest`. `null` for a local path. */
  spec: string | null;
  resolvedVersion: string | null;
  tarball: string | null;
  /** The published tarball's integrity hash: the pinned artifact identity. */
  integrity: string | null;
}

export interface KitIdentity extends CheckoutIdentity {
  entry: string;
  /** True only when `node <entry> --version` exited 0. */
  built: boolean;
}

export interface PairInspection {
  ready: boolean;
  /** One entry per unmet precondition, each naming its own repair. */
  blockers: string[];
  hyper: HyperIdentity;
  kit: KitIdentity;
}

export interface SuiteCounts {
  total: number;
  passed: number;
  failed: number;
  /** Pending + todo. Any non-zero value makes the run unverified. */
  skipped: number;
}

export interface SuiteOutcome {
  verified: boolean;
  reason: string | null;
  counts: SuiteCounts | null;
}

export function describeSurface(env?: NodeJS.ProcessEnv): PairSurface;

/**
 * Commit, branch and dirtiness of the repository rooted exactly at `root`.
 *
 * All three are `null` when `root` is not itself a repository root — including
 * when it merely sits inside one, as an npm-installed Kit under `.visp/` does.
 * Inheriting the enclosing repository's commit would attribute one project's
 * identity to another.
 */
export function gitIdentity(root: string): Pick<CheckoutIdentity, "commit" | "branch" | "dirty">;

export function inspectPair(options?: { hyperRoot?: string; kitRoot?: string }): PairInspection;

/**
 * Vitest's own `success` flag is deliberately ignored: a fully skipped file
 * reports `success: true`.
 */
export function interpretSuiteOutcome(summary: unknown): SuiteOutcome;

/** Returns the process exit code; does not exit. */
export function main(argv?: string[]): number;
