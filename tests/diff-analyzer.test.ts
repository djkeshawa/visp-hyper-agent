import { describe, expect, it } from "vitest";
import { analyzeChangedFiles, renderReviewReport } from "../src/quality/diff-analyzer.js";

describe("analyzeChangedFiles", () => {
  it("detects deterministic governance warnings", () => {
    const result = analyzeChangedFiles({
      changedFiles: ["src/index.ts", "package.json", ".env.local", "src/feature.ts"],
      relevantFiles: ["src/feature.ts"],
      blockedPaths: [".env", ".env.*", "node_modules", "dist", "build", ".git"]
    });

    expect(result.blockedFiles).toEqual([".env.local"]);
    expect(result.dependencyFiles).toEqual(["package.json"]);
    expect(result.publicApiFiles).toEqual(["src/index.ts"]);
    expect(result.outsideRelevantFiles).toEqual(["src/index.ts", "package.json", ".env.local"]);
    expect(result.hasTestChanges).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Blocked files changed: .env.local",
        "Dependency manifests or lockfiles changed: package.json",
        "Likely public API files changed: src/index.ts",
        "No test changes detected for this diff."
      ])
    );
  });

  it("renders review report warning details", () => {
    const result = analyzeChangedFiles({
      changedFiles: ["src/feature.ts", "tests/feature.test.ts"],
      relevantFiles: ["src/feature.ts", "tests/feature.test.ts"],
      blockedPaths: []
    });

    const report = renderReviewReport(result);

    expect(report).toContain("Changed files: 2");
    expect(report).toContain("Warnings: 0");
    expect(report).toContain("Has test changes: true");
    expect(report).toContain("_No deterministic warnings._");
  });
});
