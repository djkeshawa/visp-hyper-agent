// The pair check is the only thing standing between "the contract test was
// skipped" and "the contract test passed". These tests are written from that
// requirement, not from the script: each one names a way the pair could go
// unverified while something still reported success.
//
// The Vitest summaries below are not invented shapes. They are the measured
// output of `vitest run <file> --reporter=json` on this repository at 1629df5
// (Vitest 3.2.6) for a passing file and for a `describe.skipIf(true)` file —
// note that the skipped one carries `success: true`.

import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

import { describeSurface, gitIdentity, inspectPair, interpretSuiteOutcome } from "../../../scripts/pair-check.mjs";
import { resolveKitEntry } from "../../helpers/kit-entry.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PAIR_CHECK = join(PACKAGE_ROOT, "scripts", "pair-check.mjs");
const CONTRACT_TEST = join("tests", "integration", "kit", "visp-binary-contract.test.ts");

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "visp-pair-check-spec-"));
});

/** A Hyper-shaped checkout: has the contract test, and optionally Kit artifacts. */
async function fakeHyper(options: { artifacts: boolean }): Promise<string> {
  const root = join(scratch, "hyper");
  await mkdir(join(root, dirname(CONTRACT_TEST)), { recursive: true });
  await writeFile(join(root, CONTRACT_TEST), "// stand-in for the real contract test\n", "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "visp-hyper-agent", version: "9.9.9" }),
    "utf8"
  );
  if (options.artifacts) {
    await mkdir(join(root, ".visp"), { recursive: true });
    await writeFile(join(root, ".visp", "policy.json"), "{}", "utf8");
  }
  return root;
}

/** A Kit-shaped checkout whose `dist/index.js` either answers `--version` or does not. */
async function fakeKit(options: { answers: boolean }): Promise<string> {
  const root = join(scratch, "kit");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "visp-kit", version: "0.6.0" }), "utf8");
  await writeFile(
    join(root, "dist", "index.js"),
    options.answers ? "process.stdout.write('0.6.0\\n');\n" : "process.exit(3);\n",
    "utf8"
  );
  return root;
}

describe("a contract test that did not run has verified nothing", () => {
  it("refuses a fully skipped run even though Vitest calls it a success", () => {
    const measuredSkipSummary = {
      numTotalTests: 2,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 2,
      numTodoTests: 0,
      success: true
    };

    const outcome = interpretSuiteOutcome(measuredSkipSummary);

    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toMatch(/SKIPPED/);
    expect(outcome.counts).toEqual({ total: 2, passed: 0, failed: 0, skipped: 2 });
  });

  it("refuses a partially skipped run", () => {
    const outcome = interpretSuiteOutcome({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 1,
      numTodoTests: 0,
      success: true
    });

    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toContain("1 of 3");
  });

  it("refuses a run that collected no tests at all", () => {
    const outcome = interpretSuiteOutcome({
      numTotalTests: 0,
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      success: true
    });

    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toMatch(/zero tests/);
  });

  it("refuses a run with no parseable summary rather than assuming the best", () => {
    expect(interpretSuiteOutcome(undefined).verified).toBe(false);
    expect(interpretSuiteOutcome({ success: true }).verified).toBe(false);
  });

  it("refuses a failing run", () => {
    const outcome = interpretSuiteOutcome({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 0,
      success: false
    });

    expect(outcome.verified).toBe(false);
    expect(outcome.reason).toMatch(/FAILED/);
  });

  it("accepts only a run where every collected test executed and passed", () => {
    const measuredPassSummary = {
      numTotalTests: 3,
      numPassedTests: 3,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      success: true
    };

    const outcome = interpretSuiteOutcome(measuredPassSummary);

    expect(outcome).toEqual({ verified: true, reason: null, counts: { total: 3, passed: 3, failed: 0, skipped: 0 } });
  });
});

describe("preconditions are reported together, each naming its own repair", () => {
  it("blocks when the Kit build is absent, naming the path the contract test resolves", async () => {
    const hyper = await fakeHyper({ artifacts: true });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: join(scratch, "no-such-kit") });

    expect(inspection.ready).toBe(false);
    expect(inspection.blockers.join("\n")).toContain(join(scratch, "no-such-kit", "dist", "index.js"));
    expect(inspection.blockers.join("\n")).toMatch(/pnpm build|VISP_KIT_PATH/);
    expect(inspection.kit.built).toBe(false);
  });

  it("blocks when a Kit build exists but does not answer --version", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: false });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: kit });

    expect(inspection.ready).toBe(false);
    expect(inspection.kit.built).toBe(false);
    expect(inspection.blockers.join("\n")).toMatch(/not a working build/);
  });

  it("blocks when the checkout has no initialized Kit artifacts to read", async () => {
    const hyper = await fakeHyper({ artifacts: false });
    const kit = await fakeKit({ answers: true });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: kit });

    expect(inspection.ready).toBe(false);
    expect(inspection.blockers.join("\n")).toMatch(/policy\.json/);
    expect(inspection.blockers.join("\n")).toMatch(/init \. --agent none/);
  });

  it("reports every unmet precondition in one pass, not one per re-run", async () => {
    const hyper = await fakeHyper({ artifacts: false });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: join(scratch, "no-such-kit") });

    expect(inspection.blockers).toHaveLength(2);
  });

  it("is ready, and records both identities, when the pair is genuinely present", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: true });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: kit });

    expect(inspection).toMatchObject({ ready: true, blockers: [] });
    expect(inspection.kit).toMatchObject({ built: true, version: "0.6.0" });
    expect(inspection.hyper).toMatchObject({ version: "9.9.9" });
  });

  it("records no Kit version range, because Hyper no longer claims one", async () => {
    // The inspection used to carry `kitPeerRange`, read from
    // `peerDependencies.visp-kit`. That range is deleted (visp-kit ADR 0007:
    // compatibility is an exact pair pinned by commit and artifact hash), and
    // a record still carrying a range field would keep the claim alive in the
    // one place people go looking for evidence.
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: true });

    const inspection = inspectPair({ hyperRoot: hyper, kitRoot: kit });

    expect(inspection.hyper).not.toHaveProperty("kitPeerRange");
    expect(JSON.stringify(inspection)).not.toMatch(/peerDependencies|>=\s*\d+\.\d+/u);
  });
});

describe("a checkout's identity is its own, or it has none", () => {
  function git(args: string[], cwd: string): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  it("never lends an enclosing repository's commit to a directory inside it", async () => {
    // Measured, not hypothetical: the first served-pair record read
    // `Kit 0.5.0 @ ea18ece (DIRTY working tree)`. `ea18ece` is HEAD of *Hyper*
    // — the npm-installed Kit had landed under Hyper's `.visp/`, and `git -C`
    // walked up to the nearest repository. The record named the right version
    // beside the wrong commit, which is worse than naming no commit at all.
    const outer = join(scratch, "outer-repo");
    await mkdir(outer, { recursive: true });
    git(["init", "--initial-branch=main"], outer);
    git(["config", "user.email", "pair-check@example.invalid"], outer);
    git(["config", "user.name", "Pair Check"], outer);
    await writeFile(join(outer, "README.md"), "outer\n", "utf8");
    git(["add", "."], outer);
    git(["commit", "-m", "outer"], outer);

    const nested = join(outer, "node_modules", "visp-kit");
    await mkdir(nested, { recursive: true });

    expect(gitIdentity(nested)).toEqual({ commit: null, branch: null, dirty: null });
    expect(gitIdentity(outer).commit).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe("the record says which surface made the claim", () => {
  it("calls a GitHub Actions run CI and names the job", () => {
    expect(
      describeSurface({ GITHUB_ACTIONS: "true", GITHUB_WORKFLOW: "CI", GITHUB_JOB: "contract", GITHUB_RUN_ID: "42" })
    ).toEqual({ surface: "ci", detail: "CI / contract / 42" });
  });

  it("never calls a developer machine CI", () => {
    expect(describeSurface({}).surface).toBe("developer-machine");
    expect(describeSurface({ CI: "false" }).surface).toBe("developer-machine");
  });
});

describe("the CLI", () => {
  function runPairCheck(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [PAIR_CHECK, ...args], { encoding: "utf8", timeout: 120_000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  it("exits non-zero and writes a not-verified record when the pair is absent", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const record = join(scratch, "record.json");

    const result = runPairCheck(["--hyper", hyper, "--kit", join(scratch, "no-such-kit"), "--record", record]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NOT VERIFIED");
    const written = JSON.parse(await readFile(record, "utf8"));
    expect(written.verdict).toBe("not-verified");
    expect(written.contract.counts).toBeNull();
    expect(written.blockers.length).toBeGreaterThan(0);
  });

  it("never lets --preconditions-only be mistaken for a verified pair", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: true });
    const record = join(scratch, "record.json");

    const result = runPairCheck(["--hyper", hyper, "--kit", kit, "--record", record, "--preconditions-only"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("NOT run");
    const written = JSON.parse(await readFile(record, "utf8"));
    expect(written.verdict).toBe("preconditions-met");
    expect(written.verdict).not.toBe("verified");
    expect(written.contract.counts).toBeNull();
    expect(written.reason).toMatch(/not run/);
  });

  it("records identity fields as null rather than inventing them", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: true });
    const record = join(scratch, "record.json");

    runPairCheck(["--hyper", hyper, "--kit", kit, "--record", record, "--preconditions-only"]);

    const written = JSON.parse(await readFile(record, "utf8"));
    for (const side of [written.hyper, written.kit]) {
      expect(side.commit === null || typeof side.commit === "string").toBe(true);
      // "we could not ask git" must never render as "the tree is clean".
      expect(side.dirty === null || typeof side.dirty === "boolean").toBe(true);
    }
    expect(written.node).toBe(process.version);
    expect(["ci", "developer-machine"]).toContain(written.surface);
  });

  it("rejects an unknown argument instead of silently checking something else", () => {
    const result = runPairCheck(["--not-a-flag"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });

  it("refuses two different Kits rather than silently preferring one", () => {
    const result = runPairCheck(["--kit", "/somewhere", "--kit-npm", "visp-kit@latest"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pass one");
  });

  it("records where the Kit came from, so a served artifact is not read as a checkout", async () => {
    const hyper = await fakeHyper({ artifacts: true });
    const kit = await fakeKit({ answers: true });
    const record = join(scratch, "record.json");

    runPairCheck(["--hyper", hyper, "--kit", kit, "--record", record, "--preconditions-only"]);

    const written = JSON.parse(await readFile(record, "utf8"));
    // A pair verified against a local build and one verified against the
    // artifact npm serves are different claims; the record has to tell them
    // apart, and name the artifact hash when there is one.
    expect(written.kit.origin).toEqual({
      source: "path",
      spec: null,
      resolvedVersion: null,
      tarball: null,
      integrity: null
    });
  });
});

/**
 * The record names a Kit. This is the rule that makes the name true: the
 * contract test drives the Kit the pair check handed it, or it refuses.
 */
describe("the contract test runs the Kit it was handed, or none", () => {
  const present = (path: string) => path.includes("good-kit");

  it("prefers an explicitly named Kit over the sibling checkout", () => {
    const resolution = resolveKitEntry({
      repoRoot: "/repo",
      env: { VISP_KIT_PATH: "/elsewhere/good-kit" },
      exists: () => true
    });

    expect(resolution).toEqual({ entry: join("/elsewhere/good-kit", "dist", "index.js"), source: "env" });
  });

  it("throws rather than falling back when the named Kit is not built", () => {
    expect(() =>
      resolveKitEntry({ repoRoot: "/repo", env: { VISP_KIT_PATH: "/elsewhere/stale-kit" }, exists: present })
    ).toThrow(/Refusing to fall back to another Kit/u);
  });

  it("falls back to the sibling checkout only when no Kit was named", () => {
    expect(resolveKitEntry({ repoRoot: "/repo", env: {}, exists: () => true })).toEqual({
      entry: join("/repo", "..", "visp-kit", "dist", "index.js"),
      source: "sibling"
    });
  });

  it("reports no Kit rather than guessing when neither exists", () => {
    expect(resolveKitEntry({ repoRoot: "/repo", env: {}, exists: () => false })).toEqual({
      entry: null,
      source: "none"
    });
  });

  it("treats an empty VISP_KIT_PATH as unset", () => {
    expect(resolveKitEntry({ repoRoot: "/repo", env: { VISP_KIT_PATH: "" }, exists: () => true }).source).toBe(
      "sibling"
    );
  });
});
