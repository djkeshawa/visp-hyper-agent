// LC-93 — the memory bridge was off by default in the projects that had a store.
//
// `visp recall` refused with "visp-memory is installed and this project has a
// store, but the project is still configured for file memory". One command
// fixed it, so the plumbing was never the defect: the DEFAULT was. A package
// the user had installed and initialised sat inert for a whole battleground
// round because nothing selected it and nothing said so.
//
// PATH is controlled here so the verdict does not depend on what the machine
// running the suite happens to have installed.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultMemoryMode,
  memoryStoreIsReachable
} from "../../../src/memory/memory-mode-default.js";
import { MEMORY_STORE_MANIFEST } from "../../../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "../../helpers/fake-host-binary.js";

let projectDir: string;
let originalPath: string | undefined;
let emptyPath: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "visp-memory-default-"));
  emptyPath = await mkdtemp(join(tmpdir(), "visp-empty-path-"));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(projectDir, { recursive: true, force: true });
});

async function giveProjectAStore(): Promise<void> {
  await writeFile(join(projectDir, MEMORY_STORE_MANIFEST), "version: 1\n", "utf8");
}

async function putMemoryCliOnPath(): Promise<void> {
  process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
}

describe("memoryStoreIsReachable", () => {
  it("is true only when the CLI is installed and this project has a store", async () => {
    await putMemoryCliOnPath();
    await giveProjectAStore();

    expect(await memoryStoreIsReachable(projectDir)).toBe(true);
  });

  it("is false when the CLI is installed but this project has no store", async () => {
    // Not a near miss to be rounded up: pointing the verbs at a store that does
    // not exist moves the failure from the configuration to the visp-memory
    // contract, where it is reported as "upgrade visp-memory" — a confident
    // misdiagnosis rather than a missing store.
    await putMemoryCliOnPath();

    expect(await memoryStoreIsReachable(projectDir)).toBe(false);
  });

  it("is false when this project has a store but nothing can read it", async () => {
    process.env.PATH = emptyPath;
    await giveProjectAStore();

    expect(await memoryStoreIsReachable(projectDir)).toBe(false);
  });
});

describe("defaultMemoryMode", () => {
  it("selects llm-memory for a project that already has a reachable store", async () => {
    await putMemoryCliOnPath();
    await giveProjectAStore();

    expect(
      await defaultMemoryMode(projectDir),
      "The store exists and the CLI is installed, and the default still switched Memory off. " +
        "That single choice is why an installed package produced nothing for a whole round."
    ).toBe("llm-memory");
  });

  it("stays on file memory when there is no store to point at", async () => {
    process.env.PATH = emptyPath;

    expect(await defaultMemoryMode(projectDir)).toBe("file");
  });
});
