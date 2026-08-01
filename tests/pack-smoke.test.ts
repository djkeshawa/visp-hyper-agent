import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { createToolContext } from "../src/mcp/tool-bridge.js";
import "./cockpit-packed-pair-smoke.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distIndex = join(packageRoot, "dist", "index.js");

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `npm pack` computes the tarball file list from `files` + disk. We skip the
 * `prepack` build with `--ignore-scripts` for speed, so the dist artifacts must
 * already exist on disk for the file-list assertions to be meaningful. The
 * package test script builds first; direct Vitest runs still build on demand.
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
    if (!(await fileExists(distIndex))) {
      await execFileResolved("pnpm", ["build"], { cwd: packageRoot, timeout: 300_000 });
    }
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

  it("declares the exact supported Kit package as an optional peer", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };

    expect(manifest.peerDependencies?.["visp-kit"]).toBe("0.3.0");
    expect(manifest.peerDependenciesMeta?.["visp-kit"]).toEqual({ optional: true });
    expect(manifest.dependencies?.["visp-kit"]).toBeUndefined();
    expect(manifest.devDependencies?.["visp-kit"]).toBeUndefined();
    expect(manifest.optionalDependencies?.["visp-kit"]).toBeUndefined();
  });
});
