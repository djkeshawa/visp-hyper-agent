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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkMemory } from "../../../../src/cli/commands/doctor/host-checks.js";
import type { HyperConfig } from "../../../../src/core/types.js";
import { MEMORY_INSTALL_COMMAND } from "../../../../src/memory/visp-memory-install.js";
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
