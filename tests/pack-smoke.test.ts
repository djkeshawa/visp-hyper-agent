import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { createToolContext } from "../src/mcp/tool-bridge.js";
import { packageRoot } from "./helpers/dist-paths.js";
import "./cockpit-packed-pair-smoke.js";

/**
 * `npm pack` computes the tarball file list from `files` + disk. We skip the
 * `prepack` build with `--ignore-scripts` for speed, so the dist artifacts must
 * already exist on disk for the file-list assertions to be meaningful. The
 * suite's `globalSetup` (tests/setup/build-dist.ts) has built them before this
 * file is collected.
 */
async function packFiles(): Promise<string[]> {
  const { stdout } = await execFileResolved(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  return parsed.flatMap((entry) => entry.files.map((file) => file.path));
}

describe("npm pack smoke", () => {
  let files: string[];

  beforeAll(async () => {
    files = await packFiles();
  }, 320_000);

  it("ships the published artifacts", () => {
    expect(files).toContain("dist/index.js");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("package.json");
    expect(files.some((path) => path.startsWith("templates/claude-code/agents/"))).toBe(true);
  });

  it("excludes source, tests, and local scaffolding", () => {
    const forbiddenPrefixes = [
      "src/",
      "tests/",
      ".visp/",
      "examples/",
      // Internal design records. User-facing docs under docs/ do ship, but
      // these are working notes and would be noise on a package page.
      "docs/adr/",
      "docs/architecture/"
    ];
    for (const prefix of forbiddenPrefixes) {
      const leaked = files.filter((path) => path.startsWith(prefix));
      expect(leaked, `expected no ${prefix} entries, got ${leaked.join(", ")}`).toEqual([]);
    }

    // Only the reference material the README links to. Listing it exactly means
    // a new internal document cannot start shipping by accident.
    expect(files.filter((path) => path.startsWith("docs/")).sort()).toEqual([
      "docs/cockpit.md",
      "docs/commands.md",
      "docs/configuration.md",
      "docs/development.md",
      "docs/mcp.md",
      // Ships because a reader deciding whether to install needs it: it is what
      // says a green suite is not the same claim as a verified Kit pairing.
      "docs/pair-verification.md",
      "docs/quickstart.md",
      "docs/workflows.md"
    ]);
  });

  it("advertises the MCP server version in sync with package.json", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const { serverInfo } = createToolContext("/tmp");
    expect(serverInfo.version).toBe(manifest.version);
  });

  it("declares the bridge-window Kit range as an optional peer", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    // The range must include the Kit this Hyper is meant to drive. It read
    // "<0.5.0" while Kit moved to 0.5.0, which would have published an unmet
    // peer dependency for every user installing the pair — caught at the
    // publish gate, not by a test, which is why this assertion now exists.
    expect(manifest.peerDependencies?.["visp-kit"]).toBe(">=0.2.3 <0.7.0");
    expect(manifest.peerDependenciesMeta?.["visp-kit"]).toEqual({ optional: true });
    expect(manifest.dependencies?.["visp-kit"]).toBeUndefined();
    expect(manifest.devDependencies?.["visp-kit"]).toBeUndefined();
    expect(manifest.optionalDependencies?.["visp-kit"]).toBeUndefined();
  });

  it("the peer range admits the Kit version this package is built against", async () => {
    // A range that excludes the current Kit is invisible in this repo and only
    // surfaces in a user's install. Derive it rather than restating a literal.
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      peerDependencies?: Record<string, string>;
    };
    const range = manifest.peerDependencies?.["visp-kit"] ?? "";
    const upper = /<\s*(\d+)\.(\d+)\.(\d+)/u.exec(range);
    expect(upper).not.toBeNull();

    const kitPackage = JSON.parse(
      await readFile(join(packageRoot, "..", "visp-kit", "package.json"), "utf8")
    ) as { version: string };
    const [kMaj, kMin] = kitPackage.version.split(".").map(Number);
    const [, uMaj, uMin] = (upper ?? []).map(Number);

    const kitBelowUpperBound = kMaj < uMaj || (kMaj === uMaj && kMin < uMin);
    expect(kitBelowUpperBound).toBe(true);
  });
});
