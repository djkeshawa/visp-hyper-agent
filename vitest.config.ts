import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Spawn-heavy integration tests drive real git/npm/pnpm through child
    // processes; on Windows those go through cmd.exe shims and are slower under
    // parallel worker load, so the 5s default flakes. 30s is comfortably above
    // observed worst cases while still catching genuine hangs.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});

