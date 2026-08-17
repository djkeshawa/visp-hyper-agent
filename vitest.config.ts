import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Build `dist/` once, before any test file is collected. Suites that drive
    // the published artifact (spawned `node dist/index.js`, `npm pack`, git
    // hook rendering) used to each carry their own `beforeAll` build, so a file
    // run on its own from a clean clone failed on the first try and passed on
    // the second. The precondition belongs to the run, not to the test that
    // happens to notice it missing — see the file for the measured numbers.
    globalSetup: ["tests/setup/build-dist.ts"],
    // Remove any globally installed visp-kit / visp / visp-hyper from PATH
    // before a test runs. Without this the suite passes only on a machine where
    // the product is NOT installed — see the file for the measured numbers.
    setupFiles: ["tests/setup/isolate-installed-visp.ts"],
    // Spawn-heavy integration tests drive real git/npm/pnpm through child
    // processes; on Windows those go through cmd.exe shims and are slower under
    // parallel worker load, so the 5s default flakes. 30s is comfortably above
    // observed worst cases while still catching genuine hangs.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "lcov"],
      // Thresholds start at the measured baseline and only ever rise. A
      // threshold below what the suite already achieves silently permits
      // regression, which is the failure mode a threshold exists to prevent —
      // and these sat at 0 under this very sentence until LC-54, so the comment
      // described an intention nobody had implemented while reading as policy.
      //
      // Measured on this commit, Linux / Node 22, `pnpm test:coverage`:
      //   statements 89.47% (16802/18778)   branches 85.20% (4395/5158)
      //   functions  93.67% (800/854)       lines    89.47% (16802/18778)
      // Written down to the hundredth and NOT rounded up. A threshold above the
      // measurement fails the next honest run; a threshold rounded down for
      // comfort is the regression gap this exists to close.
      //
      // Branches is pinned at 85.2 and not at the 85.21 a second run of the same
      // commit reported: the v8 provider's branch TOTAL moved between two runs
      // of identical code (5158 then 5159), and the first pin at 85.21 failed
      // the very next run at 85.20. A threshold inside that jitter is a flaky
      // gate, which teaches people to lower thresholds — the one habit this
      // ratchet exists to prevent.
      //
      // Branches crossed the crew's 85% floor here for the first time, carried
      // by LC-93/LC-94's own tests rather than by work aimed at the number. That
      // does not close LC-50: this is one measurement on one platform, and a
      // threshold is a ratchet, not a verdict on the gap it was raised for.
      thresholds: { lines: 89.47, statements: 89.47, functions: 93.67, branches: 85.2 }
    }
  }
});

