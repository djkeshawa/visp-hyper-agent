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

export interface HyperIdentity extends CheckoutIdentity {
  /** Hyper's declared `peerDependencies.visp-kit` range. Recorded, not enforced. */
  kitPeerRange: string | null;
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

export function inspectPair(options?: { hyperRoot?: string; kitRoot?: string }): PairInspection;

/**
 * Vitest's own `success` flag is deliberately ignored: a fully skipped file
 * reports `success: true`.
 */
export function interpretSuiteOutcome(summary: unknown): SuiteOutcome;

/** Returns the process exit code; does not exit. */
export function main(argv?: string[]): number;
