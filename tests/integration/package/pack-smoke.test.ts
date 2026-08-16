import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileResolved } from "../../../src/core/executable-resolver.js";
import { createToolContext } from "../../../src/mcp/tool-bridge.js";
import { packageRoot } from "../../helpers/dist-paths.js";
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

  // Kit↔Hyper compatibility is an exact pair, pinned by commit and artifact
  // hash (visp-kit ADR 0007). The manifest used to carry
  // `peerDependencies: { "visp-kit": ">=0.2.3 <0.7.0" }`, which npm never
  // enforced (it was `optional: true`), which ranged over version strings the
  // compatibility matrix deliberately does not record, and whose floor —
  // `visp-kit@0.2.3` — is the one build that matrix marks hazardous, because
  // it still declares the `visp` binary Hyper now owns. Narrowing it would
  // have been the same claim with better bounds. It is gone, and this test is
  // what keeps it gone.
  it("publishes no supported-version range for visp-kit, in any dependency field", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;

    const dependencyFields = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "bundledDependencies",
      "bundleDependencies"
    ] as const;

    for (const field of dependencyFields) {
      const block = manifest[field];
      if (block === undefined) continue;
      const names = Array.isArray(block) ? block : Object.keys(block as Record<string, unknown>);
      expect(names, `${field} must make no claim about visp-kit`).not.toContain("visp-kit");
    }

    // Belt and braces: no field anywhere in the manifest may key a semver
    // range off Kit's name, whatever a future maintainer calls the block.
    const manifestText = JSON.stringify(manifest);
    expect(manifestText).not.toMatch(/"visp-kit"\s*:\s*"[^"]*\d/u);
  });

  it("points at the pinned-pair check instead, and that check is runnable without a private repo", async () => {
    // Deleting the range removes a (false) guarantee. What replaces it has to
    // exist and be runnable, or the deletion is just a quieter silence:
    // `pnpm test:pair:served` resolves the Kit npm actually serves and drives
    // it, no repository secret and no visp-kit checkout involved.
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      files?: string[];
    };

    expect(manifest.scripts?.["test:pair:served"]).toMatch(/pair-check\.mjs/u);
    expect(manifest.scripts?.["test:pair:served"]).toMatch(/--kit-npm/u);
    expect(manifest.files).toContain("docs/pair-verification.md");
  });
});
