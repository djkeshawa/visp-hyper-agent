import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { detectVisp, KitCommandBridge } from "../../../src/kit/kit-command-bridge.js";
import { resolveKitEntry } from "../../helpers/kit-entry.js";

/**
 * Contract test against the REAL `visp` binary. The fixture shim
 * (tests/helpers/visp-shim.ts) does not validate CLI flags, so bridge
 * invocation drift (flag names/order, output shape) is invisible to the rest of
 * the suite — three real bugs were historically only caught by live-testing.
 * This pins the read-only invocations (`status`, `policy validate`) against the
 * installed binary. It is SKIPPED when a Kit build or an initialized `.visp/`
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
  const result = spawnSync("visp", ["--version"], { encoding: "utf8" });
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

describe.skipIf(!RUN_LIVE)("real visp binary contract", () => {
  it("detectVisp parses a live `visp status --json` against this repo's kit", async () => {
    const result = await detectVisp(REPO_ROOT, { binary: LOCAL_BINARY ?? undefined });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.status.initialized).toBe(true);
    }
  });

  it("policyValidate parses a live `visp policy validate --json`", async () => {
    const bridge = new KitCommandBridge({ projectPath: REPO_ROOT, binary: LOCAL_BINARY ?? undefined });
    const result = await bridge.policyValidate();
    expect(result).not.toBeNull();
    expect(typeof result?.success).toBe("boolean");
    expect(Array.isArray(result?.errors)).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });

  it("consumes live Kit v2 through the explicit negotiated canonical API", async () => {
    const bridge = new KitCommandBridge({ projectPath: REPO_ROOT, binary: LOCAL_BINARY ?? undefined });
    const action = await bridge.nextCanonicalAction("2.0");
    expect(action?.source.protocolVersion).toBe("2.0");
    expect(["ready", "blocked", "inconclusive"]).toContain(action?.verdict);
    expect(Array.isArray(action?.requiredReads)).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });
});
