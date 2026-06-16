import { describe, expect, it } from "vitest";

import { isBlockedPath } from "../src/governance/blocked-files.js";

const patterns = [".env", ".env.*", "node_modules", "dist", "build", ".git"];

describe("isBlockedPath", () => {
  describe("exact match (non-'.*' pattern, === branch)", () => {
    it("blocks a path equal to '.env'", () => {
      expect(isBlockedPath(".env", patterns)).toBe(true);
    });

    it("blocks a path equal to 'node_modules'", () => {
      expect(isBlockedPath("node_modules", patterns)).toBe(true);
    });

    it("blocks a path equal to 'dist'", () => {
      expect(isBlockedPath("dist", patterns)).toBe(true);
    });

    it("blocks a path equal to 'build'", () => {
      expect(isBlockedPath("build", patterns)).toBe(true);
    });

    it("blocks a path equal to '.git'", () => {
      expect(isBlockedPath(".git", patterns)).toBe(true);
    });
  });

  describe("directory-prefix match (startsWith pattern + '/')", () => {
    it("blocks 'node_modules/foo/bar.js'", () => {
      expect(isBlockedPath("node_modules/foo/bar.js", patterns)).toBe(true);
    });

    it("blocks 'dist/index.js'", () => {
      expect(isBlockedPath("dist/index.js", patterns)).toBe(true);
    });

    it("blocks '.git/config'", () => {
      expect(isBlockedPath(".git/config", patterns)).toBe(true);
    });

    it("blocks 'build/output.css'", () => {
      expect(isBlockedPath("build/output.css", patterns)).toBe(true);
    });
  });

  describe("'.*' suffix pattern ('.env.*')", () => {
    it("blocks '.env.local' via the startsWith '.env.' branch", () => {
      expect(isBlockedPath(".env.local", patterns)).toBe(true);
    });

    it("blocks '.env' via the === branch of the '.*' pattern (and the exact '.env' pattern)", () => {
      expect(isBlockedPath(".env", patterns)).toBe(true);
    });

    it("blocks '.env.production'", () => {
      expect(isBlockedPath(".env.production", patterns)).toBe(true);
    });

    it("blocks '.env.*' even when the bare '.env' pattern is absent", () => {
      // Isolate the '.*' branch: only the suffix pattern is present.
      expect(isBlockedPath(".env.local", [".env.*"])).toBe(true);
      expect(isBlockedPath(".env", [".env.*"])).toBe(true);
    });
  });

  describe("negative near-misses (must NOT be blocked)", () => {
    it("does not block '.envfile' (neither exact '.env' nor '.env.*')", () => {
      expect(isBlockedPath(".envfile", patterns)).toBe(false);
    });

    it("does not block 'node_modules2/x' via the '/' rule", () => {
      expect(isBlockedPath("node_modules2/x", patterns)).toBe(false);
    });

    it("does not block 'srcdist/x' (not under 'dist/')", () => {
      expect(isBlockedPath("srcdist/x", patterns)).toBe(false);
    });

    it("does not block 'my.env' (not '.env')", () => {
      expect(isBlockedPath("my.env", patterns)).toBe(false);
    });

    it("does not block 'README.md'", () => {
      expect(isBlockedPath("README.md", patterns)).toBe(false);
    });

    it("does not block 'distance' (prefix of pattern but not equal and no '/')", () => {
      expect(isBlockedPath("distance", patterns)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("blocks nothing when the pattern list is empty", () => {
      expect(isBlockedPath(".env", [])).toBe(false);
      expect(isBlockedPath("node_modules/foo", [])).toBe(false);
      expect(isBlockedPath("anything", [])).toBe(false);
    });

    it("blocks a path equal to a non-'.*' pattern with no trailing slash content", () => {
      // path exactly equals the pattern: matched by the === branch, not the '/' branch.
      expect(isBlockedPath("dist", ["dist"])).toBe(true);
    });

    it("does not block a bare pattern name with a trailing slash and nothing after when path differs", () => {
      // 'dist/' starts with 'dist/' so it is blocked; sanity-check the boundary.
      expect(isBlockedPath("dist/", ["dist"])).toBe(true);
      expect(isBlockedPath("dis", ["dist"])).toBe(false);
    });
  });
});
