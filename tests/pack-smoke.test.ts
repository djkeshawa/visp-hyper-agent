import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { runCliCommand } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { createToolContext } from "../src/mcp/tool-bridge.js";
import { PACKAGE_VERSION } from "../src/version.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `pnpm test` builds dist once in its pretest lifecycle before Vitest starts.
 * Skip npm's prepack lifecycle here so this suite inspects that exact build
 * without starting a second, concurrent build from a test worker.
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

function relativeMarkdownTargets(markdownPath: string, markdown: string): string[] {
  const directory = posix.dirname(markdownPath);
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(
      (target) =>
        target.length > 0 &&
        !target.startsWith("#") &&
        !/^[a-z][a-z+.-]*:/iu.test(target)
    )
    .map((target) => target.split("#", 1)[0] ?? "")
    .filter((target) => target.length > 0)
    .map((target) => posix.normalize(posix.join(directory, target)));
}

describe("npm pack smoke", () => {
  let files: string[];

  beforeAll(async () => {
    files = await packFiles();
  }, 120_000);

  it("ships the published artifacts", () => {
    expect(files).toContain("dist/index.js");
    expect(files).toContain("README.md");
    expect(files).toContain("examples/quickstart.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("package.json");
    expect(files.some((path) => path.startsWith("templates/claude-code/agents/"))).toBe(true);
  });

  it("excludes source, tests, and local scaffolding", () => {
    const forbiddenPrefixes = ["src/", "tests/", ".visp/", "docs/"];
    for (const prefix of forbiddenPrefixes) {
      const leaked = files.filter((path) => path.startsWith(prefix));
      expect(leaked, `expected no ${prefix} entries, got ${leaked.join(", ")}`).toEqual([]);
    }
    expect(files.filter((path) => path.startsWith("examples/"))).toEqual([
      "examples/quickstart.md"
    ]);
  });

  it("keeps CLI and MCP versions in sync with package.json", async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const output: string[] = [];
    const result = await runCliCommand(["node", "visp-hyper", "--version"], {
      writeOut: (chunk) => output.push(chunk),
      writeErr: () => undefined
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("").trim()).toBe(manifest.version);
    expect(PACKAGE_VERSION).toBe(manifest.version);
    const { serverInfo } = createToolContext("/tmp");
    expect(serverInfo.version).toBe(manifest.version);
  });

  it("ships every relative documentation link target", async () => {
    for (const markdownPath of ["README.md", "examples/quickstart.md"]) {
      const markdown = await readFile(join(packageRoot, markdownPath), "utf8");
      for (const target of relativeMarkdownTargets(markdownPath, markdown)) {
        expect(files, `${markdownPath} links to missing packaged file ${target}`).toContain(target);
      }
    }
  });
});
