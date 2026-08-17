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
      // TWO RUNNERS MEASURE THIS SUITE AND THEY DISAGREE. Both of these are
      // real `pnpm test:coverage` runs of the SAME commit, same 1448 passing
      // tests:
      //
      //   hosted, the coverage job, Linux / Node 22:
      //     statements 89.45% (16797/18778)   branches 85.18% (4394/5158)
      //     functions  93.79% (801/854)       lines    89.45% (16797/18778)
      //   local, a developer running `pnpm check`, Linux / Node 26:
      //     statements 89.47% (16802/18778)   branches 85.22% (4400/5163)
      //     functions  93.67% (800/854)       lines    89.47% (16802/18778)
      //
      // The v8 provider's branch TOTAL moves too (5158 / 5159 / 5163 across
      // three runs), so this is not simply "one platform covers more".
      //
      // EACH FIGURE IS PINNED AT THE LOWER OF THE TWO. That is not rounding
      // down for comfort — the comfort case is a threshold no honest run can
      // satisfy, and it arrives as a red gate that the next person under time
      // pressure lowers. A threshold above either measurement makes one of the
      // two runners permanently red for a reason that is not the code: pinning
      // at the local numbers turned the hosted coverage job red on LC-93's
      // first push while every one of the four `check` jobs, Windows included,
      // was green. *Written after doing exactly that.*
      //
      // Written to the hundredth and never rounded up. Every figure here is
      // still well above the baseline it replaced (88.91 / 84.23 / 93.63).
      //
      // Branches crossed the crew's 85% floor here for the first time, carried
      // by LC-93/LC-94's own tests rather than by work aimed at the number. That
      // does not close LC-50: a threshold is a ratchet, not a verdict on the gap
      // it was raised for, and 85.18% is one point above the floor on a metric
      // that has moved 0.04 between runs of identical code.
      thresholds: { lines: 89.45, statements: 89.45, functions: 93.67, branches: 85.18 }
    }
  }
});

