import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeProject, readConfig, readState } from "../../../src/core/session-manager.js";
import { writeText } from "../../../src/core/fs-utils.js";
import { defaultConfig } from "../../../src/core/defaults.js";
import { MEMORY_STORE_MANIFEST } from "../../../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "../../helpers/fake-host-binary.js";

async function hyperDir(projectPath: string): Promise<string> {
  const dir = join(projectPath, ".visp", "hyper");
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("store readers degrade, never crash", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("readConfig falls back to defaults (with a warning) on unparseable JSON", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const dir = await hyperDir(projectPath);
    // Pre-seed a corrupt file so initializeProject leaves it in place.
    await writeFile(join(dir, "config.json"), "{ not valid json", "utf8");
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((m?: unknown) => warnings.push(String(m)));

    const config = await readConfig(projectPath);

    expect(config).toEqual(defaultConfig);
    expect(warnings.join("\n")).toContain("config.json could not be parsed as JSON");
    expect(warnings.join("\n")).toContain("the default configuration");
  });

  it("readConfig falls back to defaults on schema-invalid JSON", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const dir = await hyperDir(projectPath);
    // Valid JSON, wrong shape (missing required fields, bad enum).
    await writeFile(join(dir, "config.json"), JSON.stringify({ defaultTool: "nope" }), "utf8");
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((m?: unknown) => warnings.push(String(m)));

    const config = await readConfig(projectPath);

    expect(config).toEqual(defaultConfig);
    expect(warnings.join("\n")).toContain("config.json did not match the expected schema");
  });

  it("readState falls back to an empty session state on unparseable JSON", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const dir = await hyperDir(projectPath);
    await writeFile(join(dir, "state.json"), "}{ broken", "utf8");
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((m?: unknown) => warnings.push(String(m)));

    const state = await readState(projectPath);

    expect(state).toEqual({ activeSessionId: null, sessions: {} });
    expect(warnings.join("\n")).toContain("state.json could not be parsed as JSON");
    expect(warnings.join("\n")).toContain("an empty session state");
  });

  it("readState falls back to an empty session state on schema-invalid JSON", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const dir = await hyperDir(projectPath);
    await writeFile(join(dir, "state.json"), JSON.stringify({ activeSessionId: 42 }), "utf8");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const state = await readState(projectPath);

    expect(state).toEqual({ activeSessionId: null, sessions: {} });
  });

  it("a valid config round-trips unchanged (no warning, no fallback)", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((m?: unknown) => warnings.push(String(m)));

    // First read initializes the project with defaults; must not warn.
    const config = await readConfig(projectPath);

    expect(config.defaultTool).toBe(defaultConfig.defaultTool);
    expect(warnings).toEqual([]);
  });
});

// LC-93. The config a project starts with decided whether Memory ran at all,
// and it was the constant "file" regardless of what the project had.
describe("the memory mode a new project is initialized with", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    originalPath = process.env.PATH;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
  });

  async function projectWithStore(): Promise<string> {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-init-mode-"));
    await writeFile(join(projectPath, MEMORY_STORE_MANIFEST), "version: 1\n", "utf8");
    return projectPath;
  }

  it("is llm-memory when visp-memory is installed and the project already has a store", async () => {
    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    const projectPath = await projectWithStore();

    await initializeProject(projectPath);

    expect(
      (await readConfig(projectPath)).memoryMode,
      "A project holding an initialised visp-memory store was configured for file memory, " +
        "so `visp recall` refused and the store was never read or written."
    ).toBe("llm-memory");
  });

  it("is file when nothing on this machine can serve a store", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));
    const projectPath = await projectWithStore();

    await initializeProject(projectPath);

    // Memory is optional (D-118). Selecting it where it cannot work would trade
    // a silent no-op for a refusal on every recall.
    expect((await readConfig(projectPath)).memoryMode).toBe("file");
  });

  it("leaves a mode already recorded in config.json alone", async () => {
    // The store-aware choice is a DEFAULT, not an override. A user who ran
    // `visp init --memory-mode file` with a store present chose that, and
    // rewriting it would make the setting unhonourable; doctor warns instead.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-no-memory-cli-"));
    const projectPath = await projectWithStore();
    await initializeProject(projectPath);

    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    await initializeProject(projectPath);

    expect((await readConfig(projectPath)).memoryMode).toBe("file");
  });
});

describe("writeText is atomic", () => {
  it("writes the file and leaves no temp artifact behind", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-atomic-"));
    const dir = join(projectPath, "nested", "dir");
    const target = join(dir, "store.json");

    await writeText(target, "{\"v\":1}\n");

    expect(await readFile(target, "utf8")).toBe("{\"v\":1}\n");
    const entries = await readdir(dir);
    expect(entries).toEqual(["store.json"]);
    expect(entries.some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("overwrites an existing file in place", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-atomic-"));
    const target = join(projectPath, "store.json");

    await writeText(target, "first");
    await writeText(target, "second");

    expect(await readFile(target, "utf8")).toBe("second");
    const entries = await readdir(projectPath);
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});
