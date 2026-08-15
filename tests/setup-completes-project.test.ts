// Part B — `visp setup` finishes the job it claims to have finished.
//
// `runSetupVerb` used to check the machine, print the report, and stop —
// writing nothing into the project. That one omission produced both of the
// contradictions dogfooding found on a real repository, a minute apart:
//
//   $ visp setup     Setup complete. Run visp doctor any time to re-verify.
//   $ visp new "…"   Visp Kit is installed, but this project is not initialised.
//
//   $ visp setup     visp-memory 0.4.1 — ok (recall/learn available).
//   $ visp recall …  visp recall needs visp-memory, which is not configured
//                    for this project.
//
// Neither was a bug in `new` or in `recall`. The project had never been
// initialised and `memoryMode` was still at its "file" default, because
// nothing set them. "Setup complete" was simply untrue.
//
// The adapter is stubbed here rather than driven for real: what is under test
// is what Hyper does AFTER a successful machine check, not visp-dev.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "visp-setup-project-"));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(tempDir, { recursive: true, force: true });
});

/** Run `runSetupVerb` with the machine adapter reporting success. */
async function runSetup(): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));

  const machineScope = await import("../src/cli/machine/machine-scope.js");
  vi.doMock(machineScope.MACHINE_ADAPTER_SPECIFIER, () => ({
    runSetup: async () => ({
      success: true,
      report: "visp-kit: ok.\nSetup complete. Run visp doctor any time to re-verify."
    })
  }));

  const { runSetupVerb } = await import("../src/cli/machine/machine-scope.js");
  await runSetupVerb(tempDir, []);
  return lines.join("\n");
}

/** Whether a `visp-memory` command really exists on PATH — the test's own oracle. */
async function memoryCliOnPath(): Promise<boolean> {
  const { findExecutableOnPath } = await import("../src/core/executable-resolver.js");
  return (await findExecutableOnPath("visp-memory")) !== null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate, "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("setup leaves the project genuinely set up", () => {
  it("initialises Visp Hyper, so `visp new` cannot answer 'not initialised'", async () => {
    await runSetup();

    expect(
      await exists(join(tempDir, ".visp", "hyper", "config.json")),
      "setup reported completion without initialising the project, which is exactly what made " +
        "`visp new` reject the very next command."
    ).toBe(true);
  });

  it("is idempotent and does not clobber an existing config", async () => {
    await runSetup();
    const configPath = join(tempDir, ".visp", "hyper", "config.json");
    const first = await readFile(configPath, "utf8");
    const marked = JSON.stringify({ ...JSON.parse(first), sentinel: "keep me" }, null, 2);
    await writeFile(configPath, marked, "utf8");

    await runSetup();

    const second = JSON.parse(await readFile(configPath, "utf8"));
    expect(
      second.sentinel,
      "a second `visp setup` overwrote project configuration. Setup is state-changing now, so " +
        "it has to be safe to run twice."
    ).toBe("keep me");
  });

  it("enables llm-memory when visp-memory is installed AND initialised here", async () => {
    // Both conditions matter. Installed-but-not-initialised would make
    // `visp recall` fail in a new way rather than the old one.
    await writeFile(join(tempDir, "visp-memory.yaml"), "repo_id: demo\n", "utf8");

    await runSetup();

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    // visp-memory is a real dependency of this repo's test environment; when it
    // is genuinely absent the honest answer is to leave the mode alone.
    //
    // `findExecutableOnPath`, because `resolveExecutable` answers a different
    // question and on POSIX never returns null — this oracle used to read
    // "installed" on every Linux and macOS host, so the branch it is meant to
    // discriminate was never exercised.
    const memoryInstalled = await memoryCliOnPath();
    expect(config.memoryMode).toBe(memoryInstalled ? "llm-memory" : "file");
  });

  it("creates the memory store on a fresh project, so recall works after setup", async () => {
    // The final round of the fresh-project drive: setup certified
    // "recall/learn available" while nothing had ever created a store here, so
    // `visp recall` still said "not configured" seconds later. When the binary
    // is installed, setup now initialises the store itself; when it is not,
    // the honest answer remains to leave the mode alone.
    await runSetup();

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    const memoryInstalled = await memoryCliOnPath();
    expect(await exists(join(tempDir, "visp-memory.yaml"))).toBe(memoryInstalled);
    expect(config.memoryMode).toBe(memoryInstalled ? "llm-memory" : "file");
  });

  it("says visp-memory is missing rather than leaving the project quietly storeless", async () => {
    // LC-14. A whole workflow run finished with no memory store and no word
    // about it: setup could not tell that the CLI was absent (its guard was
    // unreachable on POSIX), so it tried `visp-memory init`, swallowed the
    // ENOENT, and advised running `visp-memory init` — the command the user did
    // not have. The store is created by `visp-memory init` and by nothing else,
    // so when its CLI is absent that is the fact worth printing.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const output = await runSetup();

    expect(output).toContain("visp-memory is not on PATH");
    expect(output).toContain("pip install visp-memory");
    expect(
      output,
      "advising a command that is not installed is what made the gap unactionable"
    ).not.toContain("Run `visp-memory init` in this project.");

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    expect(
      config.memoryMode,
      "setup must not certify a provider it could not reach"
    ).toBe("file");
  });

  it("installs the generic tool assets, so doctor cannot WARN about them", async () => {
    // Right after a fresh `visp setup`, doctor reported "generic asset
    // integrity differs from manifest… missing: visp-hyper-instructions.md"
    // and recommended a hidden command. Setup initialised Hyper's config but
    // never its assets.
    await runSetup();

    expect(await exists(join(tempDir, "visp-hyper-instructions.md"))).toBe(true);
  });

  it("does not overwrite customised tool assets on a second run", async () => {
    await runSetup();
    const assetPath = join(tempDir, "visp-hyper-instructions.md");
    await writeFile(assetPath, "customised by the user\n", "utf8");

    await runSetup();

    expect(await readFile(assetPath, "utf8")).toBe("customised by the user\n");
  });

  it("says what it did to the project", async () => {
    const output = await runSetup();

    expect(
      output,
      "setup changed the project without telling the user, which is worse than not changing it"
    ).toMatch(/initialised Visp Hyper/u);
  });

  it("does not claim to have initialised Kit when it could not", async () => {
    // No Kit binary is reachable in the test environment (the suite strips it
    // from PATH deliberately), so the honest output is a warning naming the one
    // command that finishes the job — never a silent success.
    await mkdir(join(tempDir, ".visp"), { recursive: true });

    const output = await runSetup();

    expect(output).not.toMatch(/initialised Visp Kit/u);
  });
});
