import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Several integration tests spawn git/npm/visp-shim subprocesses; on
    // Windows those go through cmd.exe and are much slower under full-suite
    // parallel load than the 5s default allows.
    testTimeout: 30_000
  }
});
