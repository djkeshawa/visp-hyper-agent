import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig, readState } from "../src/core/session-manager.js";
import { writeText } from "../src/core/fs-utils.js";
import { defaultConfig } from "../src/core/defaults.js";

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
