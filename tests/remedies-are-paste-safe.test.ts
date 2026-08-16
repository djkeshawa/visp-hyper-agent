// A remedy string is a command the user will paste. It has to survive their shell.
//
// Three new remedies shipped saying `pip install visp-memory[mcp,capture]`
// unquoted. In zsh `[...]` is a glob: it matches nothing, NOMATCH aborts the
// line, and pip never runs — `zsh: no matches found`. zsh is macOS's default
// login shell, so the remedy was unusable on one of the two platforms LC-9 and
// LC-14 exist to serve. bash passes the same string through literally, which is
// why it measured clean on Linux and why no amount of re-running the suite here
// could have found it.
//
// This file therefore checks the CLASS, not the instance, in two ways: the
// remedies the code actually produces are asserted to be paste-safe, and the
// printed surface in src/ is swept for the same shape so a remedy added
// tomorrow cannot reintroduce it in a file no test drives yet.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkMemory } from "../src/cli/commands/doctor/host-checks.js";
import { findMemoryGap } from "../src/cli/memory/memory-readiness.js";
import type { HyperConfig } from "../src/core/types.js";
import {
  MEMORY_INSTALL_COMMAND,
  MEMORY_STORE_MANIFEST
} from "../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "./helpers/fake-host-binary.js";

let projectDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "visp-paste-safe-"));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(projectDir, { recursive: true, force: true });
});

const config: HyperConfig = {
  defaultTool: "generic",
  tokenBudget: 100_000,
  memoryMode: "llm-memory",
  memoryEndpoint: "",
  contextMode: "deterministic",
  blockedPaths: [],
  skillMode: "auto"
};

/**
 * Every `pip install <spec>` in `text` whose spec carries an extras bracket
 * outside quotes. Empty means the text is safe to paste into zsh.
 *
 * Scoped to the shape that actually bit us rather than to `[` in general: a
 * rule broad enough to flag every bracket would flag prose and be turned off.
 */
function unquotedExtras(text: string): string[] {
  return [...text.matchAll(/pip install\s+(\S+)/gu)]
    .map((match) => match[1])
    .filter((spec) => spec.includes("[") && !/^['"]/u.test(spec));
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (extname(entry.name) === ".ts") found.push(full);
  }
  return found;
}

describe("commands Visp tells a user to paste", () => {
  it("quotes package extras, which zsh would otherwise refuse to run", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const gap = await findMemoryGap(projectDir, "llm-memory");

    expect(gap).not.toBeNull();
    expect(
      unquotedExtras(gap?.remedy ?? ""),
      "an unquoted extras spec aborts in zsh before pip runs, so this remedy does nothing at " +
        "all on macOS's default shell"
    ).toEqual([]);
    expect(gap?.remedy).toContain(MEMORY_INSTALL_COMMAND);
  });

  it("quotes them in doctor's recovery too, which is a different code path", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const check = await checkMemory(projectDir, config);

    expect(unquotedExtras(check.recovery ?? "")).toEqual([]);
    expect(check.recovery).toContain(MEMORY_INSTALL_COMMAND);
  });

  it("names the extras Visp needs, so a soft failure cannot follow the install", async () => {
    // Dropping `capture` still installs successfully and still runs, but with
    // no gitpython there is no git-history seeding — `visp-memory init`
    // reports success, captures nothing, and `recall` returns empty with no
    // link back to the install line that caused it.
    expect(MEMORY_INSTALL_COMMAND).toContain("mcp");
    expect(MEMORY_INSTALL_COMMAND).toContain("capture");
  });

  it("has no unquoted extras anywhere in the printed surface", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles("src")) {
      const bad = unquotedExtras(await readFile(file, "utf8"));
      if (bad.length > 0) offenders.push(`${file}: ${bad.join(", ")}`);
    }

    expect(
      offenders,
      "a new remedy reintroduced the shape that does not run on zsh. Quote the extras spec, or " +
        "use MEMORY_INSTALL_COMMAND."
    ).toEqual([]);
  });

  it("keeps one definition of the install command, because copies drift", async () => {
    // There were four, and one had already drifted to a form with no extras —
    // the copy a user in llm-memory mode actually reached.
    const withLiteral: string[] = [];
    for (const file of await sourceFiles("src")) {
      if (file.endsWith("visp-memory-install.ts")) continue;
      if (/pip install\s+\S*visp-memory/u.test(await readFile(file, "utf8"))) {
        withLiteral.push(file);
      }
    }

    expect(
      withLiteral,
      "the install command is spelled out here instead of imported from " +
        "src/memory/visp-memory-install.ts, which is how the four copies disagreed"
    ).toEqual([]);
  });

  it("still diagnoses a store that is merely missing, without an install line", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");

    const gap = await findMemoryGap(projectDir, "llm-memory");

    expect(gap?.missing).toContain(MEMORY_STORE_MANIFEST);
    expect(unquotedExtras(gap?.remedy ?? "")).toEqual([]);
  });

  it("goes ahead when nothing is missing", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    await writeFile(join(projectDir, MEMORY_STORE_MANIFEST), "repo_id: demo\n", "utf8");

    expect(await findMemoryGap(projectDir, "llm-memory")).toBeNull();
  });
});
