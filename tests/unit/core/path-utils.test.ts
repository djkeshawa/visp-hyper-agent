import { describe, expect, it } from "vitest";

import { toPosixPath } from "../../../src/core/path-utils.js";

describe("toPosixPath", () => {
  it("converts backslash separators to forward slashes", () => {
    expect(toPosixPath("src\\context\\relevance-scanner.ts")).toBe("src/context/relevance-scanner.ts");
  });

  it("leaves an already-POSIX path unchanged", () => {
    expect(toPosixPath("src/context/relevance-scanner.ts")).toBe("src/context/relevance-scanner.ts");
  });

  it("handles mixed separators", () => {
    expect(toPosixPath("src\\context/foo\\bar.ts")).toBe("src/context/foo/bar.ts");
  });

  it("leaves an empty string unchanged", () => {
    expect(toPosixPath("")).toBe("");
  });
});
