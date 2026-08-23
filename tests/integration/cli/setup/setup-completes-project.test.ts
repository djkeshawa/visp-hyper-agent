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
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MEMORY_INSTALL_COMMAND,
  MEMORY_STORE_MANIFEST
} from "../../../../src/memory/visp-memory-install.js";
import {
  createFakeHostBinaryDir,
  createFakeMemoryCliDir
} from "../../../helpers/fake-host-binary.js";

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

  const machineScope = await import("../../../../src/cli/machine/machine-scope.js");
  vi.doMock(machineScope.MACHINE_ADAPTER_SPECIFIER, () => ({
    runSetup: async () => ({
      success: true,
      report: "visp-kit: ok.\nSetup complete. Run visp doctor any time to re-verify."
    })
  }));

  const { runSetupVerb } = await import("../../../../src/cli/machine/machine-scope.js");
  await runSetupVerb(tempDir, []);
  return lines.join("\n");
}

/**
 * Put `dir` first on PATH, keeping the rest so the fake — which runs under
 * node — can still find one.
 */
function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
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

  // THE MACHINE IS ARRANGED, NOT CONSULTED.
  //
  // Both cases below used to compute their expectation from a helper that
  // called `findExecutableOnPath("visp-memory")` — the same predicate the code
  // under test uses to make the very decision being asserted:
  //
  //     const memoryInstalled = await memoryCliOnPath();
  //     expect(config.memoryMode).toBe(memoryInstalled ? "llm-memory" : "file");
  //
  // Oracle and subject agreed by construction, so the assertion held whatever
  // the predicate did. Regressing `findExecutableOnPath` to `return null` — a
  // total failure of the fact these branches turn on — left this file reporting
  // `9 passed (9)`. Nine green against a completely broken predicate.
  //
  // The verdict also depended on whatever the developer happened to have
  // installed, which is the same defect the PATH isolation exists to remove.
  // So each case now puts the machine it is describing on PATH and states the
  // outcome outright, the way doctor-command.test.ts does.

  it("enables llm-memory when visp-memory is installed AND initialised here", async () => {
    prependToPath(await createFakeMemoryCliDir());
    await writeFile(join(tempDir, MEMORY_STORE_MANIFEST), "repo_id: demo\n", "utf8");

    await runSetup();

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    expect(config.memoryMode).toBe("llm-memory");
  });

  it("leaves the mode alone when visp-memory is installed but no store was created", async () => {
    // The second of the two conditions, on its own. This fake answers every
    // argument with a version string, so `visp-memory init` exits 0 and creates
    // nothing — the installed-but-not-initialised machine, which would make
    // `visp recall` fail at the contract instead of at the configuration.
    prependToPath(await createFakeHostBinaryDir("visp-memory", "0.5.0"));

    const output = await runSetup();

    // "file" is ALSO what the absent-CLI case produces, so without this the
    // assertion below would be satisfied by setup never finding the arranged
    // fake at all — passing while exercising the wrong branch entirely, which
    // is the defect the rest of this block is about.
    expect(
      output,
      "setup did not find the visp-memory this case arranged, so it proved the absent-CLI " +
        "branch instead of the installed-but-storeless one it is named for"
    ).not.toContain("visp-memory is not on PATH");

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    expect(
      config.memoryMode,
      "setup certified llm-memory for a project with no store, which is the certification " +
        "`visp recall` then contradicts"
    ).toBe("file");
  });

  it("creates the memory store on a fresh project, so recall works after setup", async () => {
    // The final round of the fresh-project drive: setup certified
    // "recall/learn available" while nothing had ever created a store here, so
    // `visp recall` still said "not configured" seconds later. With the CLI
    // installed, setup has to create the store itself.
    prependToPath(await createFakeMemoryCliDir());

    await runSetup();

    const config = JSON.parse(
      await readFile(join(tempDir, ".visp", "hyper", "config.json"), "utf8")
    );
    expect(
      await exists(join(tempDir, MEMORY_STORE_MANIFEST)),
      "setup left the project storeless, so `visp recall` refuses seconds after setup said " +
        "recall was available"
    ).toBe(true);
    expect(config.memoryMode).toBe("llm-memory");
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
    // The full quoted command. `toContain("pip install visp-memory")` was
    // satisfied by the unquoted form and by a form with no extras at all, so it
    // could not have failed on either defect.
    expect(output).toContain(MEMORY_INSTALL_COMMAND);
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
