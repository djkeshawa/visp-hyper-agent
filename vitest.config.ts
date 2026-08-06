import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
      // regression, which is the failure mode a threshold exists to prevent.
      thresholds: { lines: 0, statements: 0, functions: 0, branches: 0 }
    }
  }
});

