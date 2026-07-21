import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig, readState } from "../src/core/session-manager.js";
import { writeText } from "../src/core/fs-utils.js";
import { defaultConfig } from "../src/core/defaults.js";
import {
  ProjectLockOwnershipError,
  ProjectLockTimeoutError,
  withProjectLock
} from "../src/core/project-lock.js";
import { readRoutingState } from "../src/routing/routing-state.js";
import { readTelemetry } from "../src/telemetry/telemetry-store.js";

const execFileAsync = promisify(execFile);

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

  it("telemetry and routing readers visibly warn when their stores are corrupt", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-degrade-"));
    const dir = await hyperDir(projectPath);
    await writeFile(join(dir, "telemetry.json"), "{ broken", "utf8");
    await writeFile(join(dir, "routing.json"), "[ broken", "utf8");
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });

    const telemetry = await readTelemetry(projectPath);
    const routing = await readRoutingState(projectPath);

    expect(telemetry.data).toEqual({ attempts: [], usage: [] });
    expect(routing.state).toEqual({ quarantines: [], decisions: [] });
    expect(warnings.join("\n")).toContain("telemetry.json could not be parsed as JSON");
    expect(warnings.join("\n")).toContain("routing.json could not be parsed as JSON");
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

describe("project transactions", () => {
  it("serializes concurrent work while allowing nested transactions", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));
    const events: string[] = [];
    let releaseFirst = () => {};
    let firstEntered = () => {};
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = withProjectLock(projectPath, async () => {
      events.push("first:start");
      await withProjectLock(projectPath, async () => {
        events.push("first:nested");
      });
      firstEntered();
      await holdFirst;
      events.push("first:end");
    });
    await entered;

    const second = withProjectLock(projectPath, async () => {
      events.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["first:start", "first:nested"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:nested", "first:end", "second"]);
  });

  it("releases its owner token when a transaction throws", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));

    await expect(
      withProjectLock(projectPath, async () => {
        throw new Error("transaction failed");
      })
    ).rejects.toThrow("transaction failed");

    await expect(withProjectLock(projectPath, async () => "reacquired")).resolves.toBe("reacquired");
  });

  it("times out instead of deleting a live stale owner or running unlocked", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));
    const lockPath = await seedProjectLock(projectPath, "live-owner", process.pid);
    let ran = false;

    await expect(
      withProjectLock(
        projectPath,
        async () => {
          ran = true;
        },
        { acquireTimeoutMs: 40, retryDelayMs: 5, staleAfterMs: 1 }
      )
    ).rejects.toBeInstanceOf(ProjectLockTimeoutError);

    expect(ran).toBe(false);
    expect(JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")).token).toBe("live-owner");
  });

  it("recovers a stale lock only after its owner process has exited", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      "process.stdout.write(String(process.pid))"
    ]);
    await seedProjectLock(projectPath, "dead-owner", Number(stdout));

    let ran = false;
    await withProjectLock(
      projectPath,
      async () => {
        ran = true;
      },
      { acquireTimeoutMs: 200, retryDelayMs: 5, staleAfterMs: 1 }
    );

    expect(ran).toBe(true);
    await expect(readFile(join(projectPath, ".visp", "hyper", ".project-lock", "owner.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an old ownerless directory left during lock publication", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));
    const lockPath = join(await hyperDir(projectPath), ".project-lock");
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    await expect(
      withProjectLock(projectPath, async () => "recovered", {
        acquireTimeoutMs: 200,
        retryDelayMs: 5,
        staleAfterMs: 1
      })
    ).resolves.toBe("recovered");
  });

  it("does not release a lock after its owner token changes", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-project-lock-"));
    const ownerPath = join(projectPath, ".visp", "hyper", ".project-lock", "owner.json");

    await expect(
      withProjectLock(projectPath, async () => {
        const replacement = ownerRecord("replacement-owner", process.pid, Date.now());
        await writeFile(ownerPath, `${JSON.stringify(replacement)}\n`, "utf8");
      })
    ).rejects.toBeInstanceOf(ProjectLockOwnershipError);

    expect(JSON.parse(await readFile(ownerPath, "utf8")).token).toBe("replacement-owner");
  });
});

async function seedProjectLock(projectPath: string, token: string, pid: number): Promise<string> {
  const lockPath = join(await hyperDir(projectPath), ".project-lock");
  await mkdir(lockPath);
  const acquiredAtMs = Date.now() - 60_000;
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify(ownerRecord(token, pid, acquiredAtMs))}\n`,
    "utf8"
  );
  return lockPath;
}

function ownerRecord(token: string, pid: number, acquiredAtMs: number) {
  return {
    version: 1,
    token,
    pid,
    acquiredAt: new Date(acquiredAtMs).toISOString(),
    acquiredAtMs
  };
}
