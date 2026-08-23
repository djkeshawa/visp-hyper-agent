import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  detectVisp,
  KIT_DEFAULT_TIMEOUT_MS,
  KIT_NO_SPAWN_DEADLINE_MS,
  KitCommandBridge
} from "../../../src/kit/kit-command-bridge.js";
import type { KitAvailability } from "../../../src/kit/kit-command-bridge.js";
import { resolveKitEntry } from "../../helpers/kit-entry.js";

/**
 * Contract test against the REAL `visp` binary. The fixture shim
 * (tests/helpers/visp-shim.ts) does not validate CLI flags, so bridge
 * invocation drift (flag names/order, output shape) is invisible to the rest of
 * the suite — three real bugs were historically only caught by live-testing.
 * This pins the read-only invocations (`status`, `policy validate`) against the
 * installed binary — including the warnings `status` returns, which is where a
 * Kit that cannot read its own report artifacts announces itself (LC-135). It is SKIPPED when a Kit build or an initialized `.visp/`
 * is absent, so a plain `pnpm test` on a fresh clone does not fail on their
 * account — and because a skip is not a result, `scripts/pair-check.mjs` runs
 * this file separately and treats any skip as a failure. `pnpm test:pair:served`
 * supplies both preconditions from the published Kit, with no visp-kit
 * checkout and no repository secret.
 *
 * Deliberately read-only: no `gate`/`verify`/`reconcile` calls, which would
 * mutate the working tree (e.g. .visp/reports/gate-report.md).
 */
function vispOnPath(): boolean {
  // Synchronous, at module scope, so it blocks this Vitest worker's thread
  // outright. Bounded rather than made async: a `visp --version` that has not
  // answered in the default budget is not a Kit this file can drive, and the
  // resulting skip is turned into a failure by scripts/pair-check.mjs.
  const result = spawnSync("visp", ["--version"], {
    encoding: "utf8",
    timeout: KIT_DEFAULT_TIMEOUT_MS
  });
  return !result.error && result.status === 0;
}

const REPO_ROOT = process.cwd();
const HAS_KIT_ARTIFACTS =
  existsSync(join(REPO_ROOT, ".visp", "policy.json")) || existsSync(join(REPO_ROOT, ".visp", "project.json"));
/**
 * Which Kit this test drives, in order: `$VISP_KIT_PATH`, then the sibling
 * checkout, then whatever `visp` is on PATH.
 *
 * `$VISP_KIT_PATH` exists so the Kit that was *probed* is the Kit that is
 * *exercised*: `scripts/pair-check.mjs` accepts `--kit`/`--kit-npm`, records
 * that Kit's identity, and spawns this file. Before that seam existed, a
 * `--kit` pointing anywhere but the sibling produced a record naming one Kit
 * and a run against another. See tests/helpers/kit-entry.ts.
 */
const KIT_ENTRY = resolveKitEntry({ repoRoot: REPO_ROOT }).entry;

const LOCAL_BINARY = (() => {
  if (KIT_ENTRY !== null) {
    const directory = mkdtempSync(join(tmpdir(), "visp-live-contract-"));
    if (process.platform === "win32") {
      const wrapper = join(directory, "visp.cmd");
      writeFileSync(wrapper, `@echo off\r\nnode "${KIT_ENTRY}" %*\r\n`, "utf8");
      return wrapper;
    }
    const wrapper = join(directory, "visp");
    writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${KIT_ENTRY}" "$@"\n`, "utf8");
    chmodSync(wrapper, 0o755);
    return wrapper;
  }
  return vispOnPath() ? "visp" : null;
})();
const RUN_LIVE = LOCAL_BINARY !== null && HAS_KIT_ARTIFACTS;

/**
 * LC-27. Every test here spawns a real Node process running real Kit inside a
 * parallel Vitest worker pool, and every one of them used to inherit the
 * bridge's default 10s per-spawn budget. That budget is calibrated for artifact
 * reads on the `guard` PreToolUse hot path, where a hung Kit must surface before
 * it stalls an edit. This file needs the opposite thing — a correct answer about
 * the CLI contract — so the deadline made its verdict a function of machine load
 * for no benefit, and a lost race arrived as `available: false` / `null`, which
 * reads exactly like a Kit that answered something the contract forbids.
 *
 * The measurement is in `KIT_NO_SPAWN_DEADLINE_MS`: nothing here was ever close
 * to 10s, so no number was raised. The second clock is simply gone. Vitest's own
 * per-test deadline is the outer bound, as it already is for the other real
 * process spawns across these tests, and it fails as a timeout by name.
 */
const NOTHING_WAS_LEARNED =
  "Kit never answered, so this file learned NOTHING about the contract. Read it as a " +
  "machine or environment problem, not as a Kit that broke the contract — and do not " +
  "weaken an assertion below on its account.";

function liveBridge(): KitCommandBridge {
  return new KitCommandBridge({
    projectPath: REPO_ROOT,
    binary: LOCAL_BINARY ?? undefined,
    timeoutMs: KIT_NO_SPAWN_DEADLINE_MS
  });
}

/**
 * Fail as "Kit never ran" before any contract assertion gets to fail as "Kit
 * broke the contract". A spawn that produced nothing is evidence about the
 * machine; only an answer is evidence about the pair.
 */
function refuseSilenceAsContractBreach(bridge: KitCommandBridge): void {
  const failure = bridge.lastCommandFailure;
  if (failure === undefined) return;
  expect.fail(`${NOTHING_WAS_LEARNED} (${failure.command}: ${failure.reasonCode} — ${failure.reason})`);
}

/** The same distinction for `detectVisp`, which reports it as a reason code. */
const KIT_NEVER_ANSWERED = new Set([
  "binary_not_found",
  "status_timeout",
  "status_command_failed",
  "kit_signal_probe_failed"
]);

function refuseProbeSilenceAsContractBreach(result: KitAvailability): void {
  if (result.available || !KIT_NEVER_ANSWERED.has(result.reasonCode)) return;
  expect.fail(`${NOTHING_WAS_LEARNED} (${result.reasonCode} — ${result.reason})`);
}

describe.skipIf(!RUN_LIVE)("real visp binary contract", () => {
  it(
    "detectVisp parses a live `visp status --json` against this repo's kit",
    async () => {
      const result = await detectVisp(REPO_ROOT, {
        binary: LOCAL_BINARY ?? undefined,
        timeoutMs: KIT_NO_SPAWN_DEADLINE_MS
      });
      refuseProbeSilenceAsContractBreach(result);
      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.status.initialized).toBe(true);
      }
    }
  );

  it(
    "does not call the pair verified while the live Kit cannot read its own artifacts",
    async () => {
      // LC-135. Merged develop carried `reconcile report is unreadable:
      // Unrecognized key(s) in object: 'taskStatusUpdate'` and the same for the
      // review report's `scopeBasis` — reports written by one Kit and read by
      // another — and this suite still recorded VERIFIED 3/3, because none of
      // the three tests looked at the warnings `status` was already returning.
      //
      // Read-only, so it stays inside this file's no-mutation rule. It is
      // vacuous on a `.visp/` that pair-check just initialized, since a project
      // with no reports has none to be unreadable; it bites on a checkout that
      // has actually been driven through verify/review/reconcile, which is where
      // the break was found.
      const result = await detectVisp(REPO_ROOT, {
        binary: LOCAL_BINARY ?? undefined,
        timeoutMs: KIT_NO_SPAWN_DEADLINE_MS
      });
      refuseProbeSilenceAsContractBreach(result);
      const unreadable = (result.available ? result.status.warnings ?? [] : []).filter((warning) =>
        warning.includes("is unreadable:")
      );

      expect(
        unreadable,
        "the live Kit reports an artifact it cannot parse. Whatever wrote that file and whatever " +
          "is reading it are not the same Kit — a pair that cannot read its own reports is not a " +
          "verified pair, however many contract tests pass beside it."
      ).toEqual([]);
    }
  );

  it(
    "policyValidate parses a live `visp policy validate --json`",
    async () => {
      const bridge = liveBridge();
      const result = await bridge.policyValidate();
      refuseSilenceAsContractBreach(bridge);
      expect(result).not.toBeNull();
      expect(typeof result?.success).toBe("boolean");
      expect(Array.isArray(result?.errors)).toBe(true);
      // Held at empty deliberately. The bridge has no retry or degradation
      // vocabulary: every warning it can emit names either a spawn that did not
      // run or a Kit answer the contract forbids. There is no third kind to
      // tolerate, so widening this would only tolerate a breach — the timeout
      // that motivated LC-27 is caught above, by name, before it gets here.
      expect(bridge.warnings).toEqual([]);
    }
  );

  it(
    "consumes live Kit v2 through the explicit negotiated canonical API",
    async () => {
      const bridge = liveBridge();
      const action = await bridge.nextCanonicalAction("2.0");
      refuseSilenceAsContractBreach(bridge);
      expect(action?.source.protocolVersion).toBe("2.0");
      expect(["ready", "blocked", "inconclusive"]).toContain(action?.verdict);
      expect(Array.isArray(action?.requiredReads)).toBe(true);
      expect(bridge.warnings).toEqual([]);
    }
  );
});
