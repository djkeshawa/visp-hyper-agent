import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectVisp, KitCommandBridge } from "../src/kit/kit-command-bridge.js";

/**
 * Contract test against the REAL `visp` binary. The fixture shim
 * (tests/helpers/visp-shim.ts) does not validate CLI flags, so bridge
 * invocation drift (flag names/order, output shape) is invisible to the rest of
 * the suite — three real bugs were historically only caught by live-testing.
 * This pins the read-only invocations (`status`, `policy validate`) against the
 * installed binary. It is SKIPPED when visp or an initialized kit is absent
 * (e.g. CI), so it never fails there; it runs locally where both are present.
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
const RUN_LIVE = vispOnPath() && HAS_KIT_ARTIFACTS;

describe.skipIf(!RUN_LIVE)("real visp binary contract", () => {
  it("detectVisp parses a live `visp status --json` against this repo's kit", async () => {
    const result = await detectVisp(REPO_ROOT);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.status.initialized).toBe(true);
    }
  });

  it("policyValidate parses a live `visp policy validate --json`", async () => {
    const bridge = new KitCommandBridge({ projectPath: REPO_ROOT });
    const result = await bridge.policyValidate();
    expect(result).not.toBeNull();
    expect(typeof result?.success).toBe("boolean");
    expect(Array.isArray(result?.errors)).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });
});
