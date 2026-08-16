#!/usr/bin/env node
/**
 * THE PAIR CHECK — does this Hyper checkout actually work against a real Kit
 * build, and which surface is making that claim?
 *
 * WHY THIS EXISTS
 *
 * `tests/visp-binary-contract.test.ts` is the only test that exercises the
 * Kit<->Hyper contract against the real Kit binary rather than the fixture shim
 * (`tests/helpers/visp-shim.ts`, which does not validate CLI flags — three real
 * bugs were historically caught only by live-testing). It is guarded by
 * `describe.skipIf`, because a sibling Kit build and an initialized `.visp/`
 * are not present everywhere.
 *
 * A conditional test reports its condition as a green tick. Measured on this
 * repository with Vitest 3.2.6, a fully skipped `describe` produces exactly
 * this JSON summary:
 *
 *     { numTotalTests: 2, numPassedTests: 0, numPendingTests: 2,
 *       numFailedTests: 0, success: true }
 *
 * `success: true`, nothing verified. That is the same silent wrongness
 * `tests/setup/build-dist.ts` refuses for the build precondition ("a suite that
 * skips when dist/ is absent is worse still: it goes green on a machine where
 * the thing it tests is broken"). The contract test cannot simply stop skipping
 * — the `check` CI job legitimately has no Kit, because visp-kit is a private
 * repository — so the skip has to become an error somewhere. It becomes one
 * here.
 *
 * WHAT THIS GUARANTEES
 *
 * Exit 0 from this script means all of the following were true in one run:
 *
 *   1. A Kit build was found and answered `--version`, so it is a working
 *      binary and not a stale or truncated `dist/index.js`.
 *   2. Kit artifacts existed in the Hyper checkout, so the contract test had
 *      something real to read.
 *   3. Every contract test EXECUTED and passed. Zero skipped, zero pending,
 *      and at least one test collected. `success: true` from Vitest is not
 *      accepted on its own, for the reason above.
 *
 * Anything else exits non-zero and names which of the three failed.
 *
 * WHAT THE RECORD IS FOR
 *
 * A green pair check on a developer machine and a green pair check in CI are
 * different claims, and the difference is invisible once someone says "the
 * tests pass". Every run writes a record naming the two commits it exercised,
 * whether either working tree was dirty, and which surface ran it — so the
 * claim is attributable rather than remembered. See docs/pair-verification.md.
 *
 * WHICH KIT
 *
 * `--kit` defaults to $VISP_KIT_PATH, then to the sibling `../visp-kit`.
 * `--kit-npm <spec>` installs a published Kit instead and checks against that
 * artifact — visp-kit's source repository is private, but its package is
 * public, so this is the route a fork or a fresh clone can actually take, and
 * it exercises the pair npm serves rather than two development branches.
 * Whichever is chosen, that Kit is passed to the contract test through
 * $VISP_KIT_PATH, so the Kit named in the record is the Kit that ran.
 *
 * Usage:
 *   node scripts/pair-check.mjs [--kit <path> | --kit-npm <spec>]
 *                               [--hyper <path>] [--record <path>]
 *                               [--init-if-missing] [--preconditions-only]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONTRACT_TEST = "tests/visp-binary-contract.test.ts";
const DEFAULT_RECORD = join(".visp", "hyper", "pair-check.json");

/** Reads a package.json `version`, or null when the file is absent or unreadable. */
function readVersion(packageRoot) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetches the Kit that npm actually serves for `spec` and returns its package
 * root, so the pair check can run against the published artifact instead of a
 * source checkout of a private repository.
 *
 * This is what makes the check runnable by someone who just cloned this
 * repository: `visp-kit`'s source is private, but its package is public, and
 * the published tarball is the thing a user installs anyway. `npm install`
 * rather than `npm pack`: the packed tarball's `dist/index.js` imports
 * `commander`, so an unpacked tarball cannot answer `--version`.
 *
 * The lockfile npm writes carries the tarball URL and its integrity hash. Both
 * go into the run record: compatibility here is pinned by artifact hash, so a
 * record that cannot name the artifact it exercised is not evidence.
 */
function resolveKitFromNpm(spec, cacheRoot) {
  mkdirSync(cacheRoot, { recursive: true });
  const install = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--prefix", cacheRoot, "--no-audit", "--no-fund", "--loglevel", "error", spec],
    { encoding: "utf8", stdio: "inherit", timeout: 600_000 }
  );
  if (install.error || install.status !== 0) {
    return {
      root: null,
      origin: { source: "npm", spec, resolvedVersion: null, tarball: null, integrity: null },
      error:
        `\`npm install ${spec}\` into ${cacheRoot} failed (exit ${install.status ?? "none"}` +
        `${install.error ? `, ${install.error.message}` : ""}). The served pair cannot be fetched, so it ` +
        `cannot be checked. Network access to the npm registry is required for --kit-npm; use --kit <path> ` +
        `against a local Kit build instead.`
    };
  }

  const root = join(cacheRoot, "node_modules", "visp-kit");
  let tarball = null;
  let integrity = null;
  try {
    const lock = JSON.parse(readFileSync(join(cacheRoot, "package-lock.json"), "utf8"));
    const entry = lock.packages?.["node_modules/visp-kit"] ?? null;
    tarball = entry?.resolved ?? null;
    integrity = entry?.integrity ?? null;
  } catch {
    // A missing lockfile costs provenance, not correctness: the record says
    // null rather than inventing a hash.
  }
  return {
    root,
    origin: { source: "npm", spec, resolvedVersion: readVersion(root), tarball, integrity },
    error: null
  };
}

/**
 * Initializes a Visp project in the Hyper checkout so the contract test has
 * Kit artifacts to read. Opt-in (`--init-if-missing`) and never destructive:
 * the caller only reaches this when `.visp/` holds neither `policy.json` nor
 * `project.json`, which is the fresh-clone case.
 */
function initializeKitArtifacts(kitEntry, hyperPath) {
  const init = spawnSync(process.execPath, [kitEntry, "init", ".", "--agent", "none"], {
    cwd: hyperPath,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 300_000
  });
  if (init.error || init.status !== 0) {
    return `\`<kit> init . --agent none\` failed in ${hyperPath} (exit ${init.status ?? "none"}${init.error ? `, ${init.error.message}` : ""}).`;
  }
  return null;
}

/**
 * Resolves a path through symlinks where possible, so two spellings compare
 * equal.
 *
 * `realpathSync.native`, not `realpathSync`, and the difference is the whole
 * point on Windows. The JS implementation walks the path resolving symlinks
 * and leaves everything else alone; the native one asks the OS for the final
 * name, which also expands an 8.3 short path. The two sides compared here come
 * from different programs and spell that differently: `os.tmpdir()` hands Node
 * `C:\Users\RUNNER~1\...`, while git prints the long `C:/Users/runneradmin/...`
 * it resolved for itself. Under the JS implementation those stayed unequal, so
 * a repository's own root read as "not this directory" and every identity on
 * Windows came back null — the exact silence this function exists to prevent.
 */
function canonicalPath(path) {
  for (const resolver of [realpathSync.native, realpathSync]) {
    try {
      return resolver(path);
    } catch {
      // Not resolvable this way; fall through to the next attempt.
    }
  }
  return resolve(path);
}

/**
 * Git identity of a checkout. Every field is nullable on purpose: a checkout
 * extracted from a tarball has no git metadata, and the record must say
 * `null` rather than invent a commit.
 *
 * `git -C <dir>` walks up to the nearest enclosing repository, so a directory
 * that is merely *inside* one answers with that repository's commit. A Kit
 * installed from npm lands under the Hyper checkout's `.visp/`, and the first
 * served-pair record read `Kit 0.5.0 @ ea18ece (DIRTY)` — Hyper's own commit
 * and Hyper's own dirty tree, attributed to Kit. So the identity counts only
 * when this directory *is* the repository root.
 */
export function gitIdentity(root) {
  const git = (args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    return !result.error && result.status === 0 ? result.stdout.trim() : null;
  };
  const toplevel = git(["rev-parse", "--show-toplevel"]);
  if (toplevel === null || canonicalPath(toplevel) !== canonicalPath(root)) {
    return { commit: null, branch: null, dirty: null };
  }
  const porcelain = git(["status", "--porcelain"]);
  return {
    commit: git(["rev-parse", "HEAD"]),
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    // null (not false) when git could not be consulted — "we do not know"
    // and "the tree is clean" are different facts.
    dirty: porcelain === null ? null : porcelain.length > 0
  };
}

/**
 * Which surface is making the claim. A hosted CI run and a developer machine
 * are not interchangeable evidence, so the record never has to guess.
 */
export function describeSurface(env = process.env) {
  if (env.GITHUB_ACTIONS === "true") {
    return {
      surface: "ci",
      detail: [env.GITHUB_WORKFLOW, env.GITHUB_JOB, env.GITHUB_RUN_ID].filter(Boolean).join(" / ") || "github-actions"
    };
  }
  if (env.CI && env.CI !== "false") {
    return { surface: "ci", detail: "unidentified CI (CI env var set)" };
  }
  return { surface: "developer-machine", detail: `${process.platform} ${process.arch}` };
}

/**
 * Everything that must be true before the contract test can mean anything.
 * Returns the blockers rather than throwing, so the caller can report all of
 * them at once instead of one repair round-trip per missing piece.
 */
export function inspectPair({ hyperRoot = PACKAGE_ROOT, kitRoot } = {}) {
  const blockers = [];
  const hyperPath = resolve(hyperRoot);
  const kitPath = resolve(kitRoot ?? process.env.VISP_KIT_PATH ?? join(hyperPath, "..", "visp-kit"));
  const kitEntry = join(kitPath, "dist", "index.js");

  if (!existsSync(join(hyperPath, CONTRACT_TEST))) {
    blockers.push(
      `[hyper] ${join(hyperPath, CONTRACT_TEST)} does not exist, so there is no contract test to run. ` +
        `Point --hyper at a Visp Hyper source checkout (the published package ships dist/, not tests/).`
    );
  }

  let kitAnswers = false;
  if (!existsSync(kitEntry)) {
    blockers.push(
      `[kit] ${kitEntry} does not exist. The contract test resolves the Kit binary at that exact path. ` +
        `Clone visp-kit beside this checkout and run \`pnpm build\` in it, or pass --kit <path> / set VISP_KIT_PATH.`
    );
  } else {
    const probe = spawnSync(process.execPath, [kitEntry, "--version"], { encoding: "utf8", timeout: 60_000 });
    kitAnswers = !probe.error && probe.status === 0;
    if (!kitAnswers) {
      blockers.push(
        `[kit] ${kitEntry} exists but \`node <kit>/dist/index.js --version\` did not exit 0, so it is not a ` +
          `working build. Re-run \`pnpm build\` in the Kit checkout. ` +
          `(exit ${probe.status ?? "none"}${probe.error ? `, ${probe.error.message}` : ""})`
      );
    }
  }

  // `.visp/` is gitignored, so a fresh checkout has no Kit artifacts and the
  // contract test has nothing to read. Same two files the test itself checks.
  const hasArtifacts =
    existsSync(join(hyperPath, ".visp", "policy.json")) || existsSync(join(hyperPath, ".visp", "project.json"));
  if (!hasArtifacts) {
    blockers.push(
      `[artifacts] neither .visp/policy.json nor .visp/project.json exists under ${hyperPath}, so the contract ` +
        `test has no initialized Kit project to read. Run \`node <kit>/dist/index.js init . --agent none\` there.`
    );
  }

  return {
    ready: blockers.length === 0,
    blockers,
    hyper: { path: hyperPath, version: readVersion(hyperPath), ...gitIdentity(hyperPath) },
    kit: { path: kitPath, entry: kitEntry, built: kitAnswers, version: readVersion(kitPath), ...gitIdentity(kitPath) }
  };
}

/**
 * Turns a Vitest JSON summary into a verdict.
 *
 * The one rule that matters: a test that did not run did not verify anything.
 * Vitest reports a fully skipped file as `success: true`, so `success` is
 * deliberately not consulted — every collected test must have passed, and at
 * least one must have been collected.
 */
export function interpretSuiteOutcome(summary) {
  if (!summary || typeof summary.numTotalTests !== "number") {
    return { verified: false, reason: "the contract run produced no parseable Vitest JSON summary", counts: null };
  }
  const counts = {
    total: summary.numTotalTests,
    passed: summary.numPassedTests ?? 0,
    failed: summary.numFailedTests ?? 0,
    skipped: (summary.numPendingTests ?? 0) + (summary.numTodoTests ?? 0)
  };
  if (counts.total === 0) {
    return { verified: false, reason: `${CONTRACT_TEST} collected zero tests`, counts };
  }
  if (counts.skipped > 0) {
    return {
      verified: false,
      reason:
        `${counts.skipped} of ${counts.total} contract tests were SKIPPED. A skipped contract test is not a ` +
        `passing one — Vitest still reports the run as successful, which is exactly what this check exists to catch`,
      counts
    };
  }
  if (counts.failed > 0 || counts.passed !== counts.total) {
    return { verified: false, reason: `${counts.failed} of ${counts.total} contract tests FAILED`, counts };
  }
  return { verified: true, reason: null, counts };
}

/** Runs the contract test file and returns its parsed JSON summary (or null). */
function runContractSuite(hyperPath, kitPath) {
  const scratch = mkdtempSync(join(tmpdir(), "visp-pair-check-"));
  const outputFile = join(scratch, "contract.json");
  const vitest = join(hyperPath, "node_modules", "vitest", "vitest.mjs");
  try {
    // Spawned through `process.execPath` rather than the `.bin` shim: on
    // Windows those shims are `.cmd` files that cannot be exec'd directly.
    //
    // VISP_KIT_PATH is passed explicitly so the contract test drives the same
    // Kit this script probed and is about to name in the record. Without it
    // the test falls back to the sibling checkout or to `visp` on PATH, and a
    // `--kit`/`--kit-npm` run would attribute one Kit's result to another.
    const run = spawnSync(
      process.execPath,
      [vitest, "run", CONTRACT_TEST, "--reporter=json", `--outputFile=${outputFile}`],
      {
        cwd: hyperPath,
        encoding: "utf8",
        stdio: "inherit",
        timeout: 900_000,
        env: { ...process.env, VISP_KIT_PATH: kitPath }
      }
    );
    if (run.error) return { summary: null, spawnError: run.error.message };
    if (!existsSync(outputFile)) return { summary: null, spawnError: `vitest wrote no JSON summary (exit ${run.status})` };
    return { summary: JSON.parse(readFileSync(outputFile, "utf8")), spawnError: null };
  } catch (error) {
    return { summary: null, spawnError: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function writeRecord(recordPath, record) {
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function parseArgv(argv) {
  const options = { preconditionsOnly: false, help: false, initIfMissing: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--preconditions-only") options.preconditionsOnly = true;
    else if (arg === "--init-if-missing") options.initIfMissing = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--kit") options.kitRoot = argv[++index];
    else if (arg === "--kit-npm") options.kitNpm = argv[++index];
    else if (arg === "--hyper") options.hyperRoot = argv[++index];
    else if (arg === "--record") options.record = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.kitRoot !== undefined && options.kitNpm !== undefined) {
    throw new Error("--kit and --kit-npm name two different Kits; pass one");
  }
  return options;
}

const USAGE = `visp-hyper pair check

  node scripts/pair-check.mjs [--kit <path> | --kit-npm <spec>] [--hyper <path>]
                              [--record <path>] [--init-if-missing]
                              [--preconditions-only]

Verifies this Hyper checkout against a real Visp Kit build and records which
surface made the claim. Exits non-zero when the pair cannot be verified,
including when the contract tests would silently skip.

  --kit                 Kit checkout (default: $VISP_KIT_PATH, else ../visp-kit)
  --kit-npm             Install a published Kit (e.g. visp-kit@latest) and check
                        against that artifact. Needs no visp-kit checkout, so a
                        fresh clone can run it: \`pnpm test:pair:served\`
  --hyper               Hyper checkout under test (default: this one)
  --record              Where to write the run record (default: ${DEFAULT_RECORD})
  --init-if-missing     Initialize .visp/ in the Hyper checkout when it holds no
                        Kit artifacts. Never touches an existing .visp/
  --preconditions-only  Report whether the pair COULD be verified here, and stop
                        without running the contract tests
`;

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`pair-check: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const hyperRoot = resolve(options.hyperRoot ?? PACKAGE_ROOT);
  const { surface, detail } = describeSurface();

  // A --kit-npm install lands inside the Hyper checkout's gitignored `.visp/`:
  // cached between runs, never committed, and thrown away with the rest of
  // `.visp/`.
  let kitRoot = options.kitRoot;
  let kitOrigin = { source: "path", spec: null, resolvedVersion: null, tarball: null, integrity: null };
  const fetchBlockers = [];
  if (options.kitNpm !== undefined) {
    const cacheRoot = join(hyperRoot, ".visp", "hyper", "served-kit");
    const resolved = resolveKitFromNpm(options.kitNpm, cacheRoot);
    kitRoot = resolved.root ?? join(cacheRoot, "node_modules", "visp-kit");
    kitOrigin = resolved.origin;
    if (resolved.error) fetchBlockers.push(`[kit] ${resolved.error}`);
  }

  let inspection = inspectPair({ hyperRoot, kitRoot });

  // A fresh clone has no `.visp/`, so the contract test would have nothing to
  // read. Initializing is opt-in and only reachable when there is nothing
  // there: an existing `.visp/` is never re-initialized.
  if (
    options.initIfMissing &&
    inspection.kit.built &&
    inspection.blockers.some((blocker) => blocker.startsWith("[artifacts]"))
  ) {
    process.stdout.write(
      `pair-check: no Kit artifacts under ${hyperRoot}/.visp — initializing one with the Kit under test.\n`
    );
    const initError = initializeKitArtifacts(inspection.kit.entry, hyperRoot);
    inspection = initError
      ? { ...inspection, ready: false, blockers: [`[artifacts] ${initError}`, ...inspection.blockers] }
      : inspectPair({ hyperRoot, kitRoot });
  }

  if (fetchBlockers.length > 0) {
    inspection = { ...inspection, ready: false, blockers: [...fetchBlockers, ...inspection.blockers] };
  }

  const recordPath = isAbsolute(options.record ?? DEFAULT_RECORD)
    ? options.record
    : join(inspection.hyper.path, options.record ?? DEFAULT_RECORD);

  const record = {
    checkedAt: new Date().toISOString(),
    surface,
    surfaceDetail: detail,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    hyper: inspection.hyper,
    kit: { ...inspection.kit, origin: kitOrigin },
    verdict: "not-verified",
    reason: null,
    contract: { file: CONTRACT_TEST, counts: null },
    blockers: inspection.blockers
  };

  if (!inspection.ready) {
    record.reason = "preconditions not met — the pair could not be exercised here";
    writeRecord(recordPath, record);
    process.stderr.write(
      `pair-check: NOT VERIFIED — the Kit<->Hyper pair could not be exercised.\n` +
        inspection.blockers.map((blocker) => `  - ${blocker}\n`).join("") +
        `Record: ${recordPath}\n`
    );
    return 1;
  }

  if (options.preconditionsOnly) {
    record.verdict = "preconditions-met";
    record.reason = "preconditions only — the contract tests were not run";
    writeRecord(recordPath, record);
    process.stdout.write(
      `pair-check: preconditions met. Kit ${record.kit.version ?? "?"} @ ${record.kit.commit ?? "no-git"} ` +
        `is available to Hyper ${record.hyper.version ?? "?"} @ ${record.hyper.commit ?? "no-git"}. ` +
        `Contract tests NOT run (--preconditions-only).\nRecord: ${recordPath}\n`
    );
    return 0;
  }

  const { summary, spawnError } = runContractSuite(inspection.hyper.path, inspection.kit.path);
  const outcome = spawnError
    ? { verified: false, reason: `the contract run could not complete: ${spawnError}`, counts: null }
    : interpretSuiteOutcome(summary);

  record.verdict = outcome.verified ? "verified" : "not-verified";
  record.reason = outcome.reason;
  record.contract.counts = outcome.counts;
  writeRecord(recordPath, record);

  if (!outcome.verified) {
    process.stderr.write(`pair-check: NOT VERIFIED — ${outcome.reason}.\nRecord: ${recordPath}\n`);
    return 1;
  }
  const kitProvenance =
    kitOrigin.source === "npm"
      ? ` from npm ${kitOrigin.spec}${kitOrigin.integrity ? ` (${kitOrigin.integrity})` : ""}`
      : "";
  process.stdout.write(
    `pair-check: VERIFIED on ${surface} (${detail}).\n` +
      `  Hyper ${record.hyper.version ?? "?"} @ ${record.hyper.commit ?? "no-git"}` +
      `${record.hyper.dirty ? " (DIRTY working tree)" : ""}\n` +
      `  Kit   ${record.kit.version ?? "?"} @ ${record.kit.commit ?? "no-git"}` +
      `${record.kit.dirty ? " (DIRTY working tree)" : ""}${kitProvenance}\n` +
      `  ${outcome.counts.passed}/${outcome.counts.total} contract tests executed and passed, 0 skipped.\n` +
      `Record: ${recordPath}\n`
  );
  return 0;
}

// `pnpm test:pair` runs this file directly; the tests import the functions above.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
