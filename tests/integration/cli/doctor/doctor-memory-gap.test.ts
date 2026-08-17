// LC-14 — doctor can see that Memory is not reachable.
//
// A full workflow run finished with `.visp/memory/` holding nothing but
// Kit-written markdown: no store was ever created and no verb ever reached
// visp-memory. Nothing said so. Doctor was the one surface that should have,
// and it could not — its "the visp-memory CLI is not installed" branch was
// guarded by `resolveExecutable`, which on POSIX returns the bare command name
// unconditionally. On Linux and macOS that branch was unreachable code, so
// doctor answered "llm-memory is available through the visp-memory CLI" on
// every host where the CLI was absent.
//
// A health check that cannot report ill health is worse than no check: it is
// the reason the gap survived a whole session unnoticed.
//
// PATH is controlled here so the verdict does not depend on what the machine
// running the suite happens to have installed.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkMemory } from "../../../../src/cli/commands/doctor/host-checks.js";
import type { HyperConfig } from "../../../../src/core/types.js";
import {
  MEMORY_INSTALL_COMMAND,
  MEMORY_STORE_MANIFEST
} from "../../../../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "../../../helpers/fake-host-binary.js";

let projectDir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "visp-doctor-memory-"));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(projectDir, { recursive: true, force: true });
});

const llmMemoryConfig: HyperConfig = {
  defaultTool: "generic",
  tokenBudget: 100_000,
  memoryMode: "llm-memory",
  memoryEndpoint: "",
  contextMode: "deterministic",
  blockedPaths: [],
  skillMode: "auto"
};

describe("doctor's memory provider check", () => {
  it("warns when the project is configured for llm-memory but the CLI is not on PATH", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const check = await checkMemory(projectDir, llmMemoryConfig);

    expect(
      check.status,
      "doctor passed a project whose configured memory provider does not exist on this machine. " +
        "That verdict is why a whole run went by with Memory unreachable and unreported."
    ).toBe("warn");
    expect(check.detail).toContain("visp-memory");
  });

  it("names the install, not a setup that cannot perform it", async () => {
    // `visp setup` configures what is installed; it has never installed the
    // Python package. Sending the user there repeats the LC-9 dead end.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const check = await checkMemory(projectDir, llmMemoryConfig);

    // The FULL command, quoted. `toContain("pip install visp-memory")` is
    // satisfied by the unquoted form and by a form with no extras at all —
    // both of which shipped — so it could not fail on either defect.
    expect(check.recovery).toContain(MEMORY_INSTALL_COMMAND);
    expect(check.recovery).toContain("pip install 'visp-memory[mcp,capture]'");
  });

  it("passes when the CLI is genuinely there", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");

    const check = await checkMemory(projectDir, llmMemoryConfig);

    expect(check.status).toBe("pass");
    expect(check.recovery).toBeUndefined();
  });

  it("says nothing is wrong in file mode, which needs no provider at all", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));

    const check = await checkMemory(projectDir, { ...llmMemoryConfig, memoryMode: "file" });

    expect(check.status).toBe("pass");
  });
});

// LC-93 — the second half of the same defect: doctor PASSED the setting that
// switched Memory off.
//
// "[PASS] Memory provider: File memory mode is active." was printed in a
// project holding an initialised visp-memory store. The one surface built to
// notice the bridge was disabled certified it instead, so the user had no way
// to learn that `visp recall` would refuse until it did.
describe("doctor's memory provider check, in file mode with a store present", () => {
  const fileModeConfig: HyperConfig = { ...llmMemoryConfig, memoryMode: "file" };

  async function giveProjectAStore(): Promise<void> {
    await writeFile(join(projectDir, MEMORY_STORE_MANIFEST), "version: 1\n", "utf8");
  }

  it("warns rather than passing when the project has a store the bridge is not using", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    await giveProjectAStore();

    const check = await checkMemory(projectDir, fileModeConfig);

    expect(
      check.status,
      "doctor passed a project whose installed, initialised Memory is switched off. A PASS on " +
        "the setting that disables the capability is how it stayed disabled for a whole round."
    ).toBe("warn");
  });

  it("names the one command that turns the bridge on", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    await giveProjectAStore();

    const check = await checkMemory(projectDir, fileModeConfig);

    // The remedy is the fix that was verified to work, quoted exactly. A WARN
    // that does not say what to run leaves the reader where the PASS did.
    expect(check.recovery).toContain("visp init --memory-mode llm-memory");
    expect(check.detail).toContain(MEMORY_STORE_MANIFEST);
  });

  it("still passes file mode when the CLI is installed but no store was ever created", async () => {
    // File mode is a legitimate choice, and Memory is optional (D-118). The
    // warning is about a contradiction, not about file mode.
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");

    const check = await checkMemory(projectDir, fileModeConfig);

    expect(check.status).toBe("pass");
    expect(check.recovery).toBeUndefined();
  });
});
