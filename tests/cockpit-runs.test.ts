import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cockpitArtifactPath,
  cockpitByteOffset,
  cockpitRunGeneration,
  type CockpitArtifactPath
} from "../src/cockpit/contracts.js";
import {
  COCKPIT_RUNS_DEFAULT_LIMIT,
  COCKPIT_RUNS_MAX_LIMIT,
  COCKPIT_RUN_TAIL_MAX_BYTES,
  CockpitRunsError,
  paginateCockpitRuns,
  parseCockpitRunEventsRequest,
  parseCockpitRunsPageRequest,
  tailRunEvents
} from "../src/cockpit/runs.js";

type TestEvent = Readonly<{
  runId: string;
  message: string;
}>;

const temporaryDirectories = new Set<string>();
const execFileAsync = promisify(execFile);

async function readFifoWithRescue<T>(
  fifoPath: string,
  rescue: { triggered: boolean },
  read: () => Promise<T>
): Promise<T> {
  let rescueWrite: Promise<void> | undefined;
  const rescueTimer = setTimeout(() => {
    rescue.triggered = true;
    rescueWrite = writeFile(fifoPath, eventLine("run-fifo", "rescue"), "utf8").catch(
      () => undefined
    );
  }, 250);
  try {
    return await read();
  } finally {
    clearTimeout(rescueTimer);
    await rescueWrite;
  }
}

afterEach(async () => {
  await Promise.allSettled(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

async function temporaryProject(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `visp-cockpit-runs-${label}-`));
  temporaryDirectories.add(path);
  return path;
}

async function writeEvents(
  projectPath: string,
  runId: string,
  content: string
): Promise<string> {
  const directory = join(projectPath, ".visp", "runs", runId);
  const path = join(directory, "events.jsonl");
  await mkdir(directory, { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

function eventLine(runId: string, message: string): string {
  return `${JSON.stringify({ runId, message })}\n`;
}

function validateEvent(candidate: unknown): TestEvent {
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as Record<string, unknown>).runId === "string" &&
    typeof (candidate as Record<string, unknown>).message === "string"
  ) {
    return candidate as TestEvent;
  }
  throw new TypeError("invalid test event");
}

async function openDescriptorsFor(path: string): Promise<number | null> {
  let target: string;
  let descriptors: string[];
  try {
    target = await realpath(path);
    descriptors = await readdir("/proc/self/fd");
  } catch {
    return null;
  }

  let count = 0;
  for (const descriptor of descriptors) {
    try {
      const linked = await readlink(join("/proc/self/fd", descriptor));
      if (linked === target || linked === `${target} (deleted)`) count += 1;
    } catch {
      // Descriptors can close while /proc is being inspected.
    }
  }
  return count;
}

describe("Cockpit Runs pagination", () => {
  it("parses defaults, caps the public bound, and freezes results", () => {
    const defaults = parseCockpitRunsPageRequest(new URLSearchParams());
    const bounded = parseCockpitRunsPageRequest(
      new URLSearchParams({ offset: "191", limit: String(COCKPIT_RUNS_MAX_LIMIT + 50) })
    );

    expect(defaults).toEqual({ offset: 0, limit: COCKPIT_RUNS_DEFAULT_LIMIT });
    expect(bounded).toEqual({ offset: 191, limit: COCKPIT_RUNS_MAX_LIMIT });
    expect(Object.isFrozen(defaults)).toBe(true);
  });

  it.each([
    ["duplicate offset", "offset=0&offset=1"],
    ["duplicate limit", "limit=1&limit=2"],
    ["negative offset", "offset=-1"],
    ["fractional offset", "offset=1.5"],
    ["blank offset", "offset="],
    ["unsafe offset", `offset=${Number.MAX_SAFE_INTEGER + 1}`],
    ["zero limit", "limit=0"],
    ["negative limit", "limit=-1"],
    ["fractional limit", "limit=1.5"],
    ["unknown parameter", "cursor=1"]
  ])("rejects %s", (_label, query) => {
    expect(() => parseCockpitRunsPageRequest(new URLSearchParams(query))).toThrow(
      CockpitRunsError
    );
  });

  it("paginates at least 191 records newest-first without mutating the input", () => {
    const runs = Array.from({ length: 191 }, (_, index) => ({
      id: `run-${String(index).padStart(3, "0")}`,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      marker: index
    }));
    const originalOrder = runs.map(({ id }) => id);
    const sourcePath = cockpitArtifactPath(".visp/runs/index.json");

    const first = paginateCockpitRuns(runs, sourcePath);
    const second = paginateCockpitRuns(runs, sourcePath, { offset: 64, limit: 64 });
    const third = paginateCockpitRuns(runs, sourcePath, { offset: 128, limit: 64 });

    expect(first.runs).toHaveLength(64);
    expect(first.runs[0]?.id).toBe("run-190");
    expect(first.runs.at(-1)?.id).toBe("run-127");
    expect(first.nextOffset).toBe(64);
    expect(second.runs[0]?.id).toBe("run-126");
    expect(second.nextOffset).toBe(128);
    expect(third.runs).toHaveLength(63);
    expect(third.runs.at(-1)?.id).toBe("run-000");
    expect(third.nextOffset).toBeNull();
    expect(third.total).toBe(191);
    expect(runs.map(({ id }) => id)).toEqual(originalOrder);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.runs)).toBe(true);
  });

  it("orders timestamp ties deterministically, including duplicate IDs", () => {
    const startedAt = "2026-08-01T00:00:00.000Z";
    const runs = [
      { id: "run-a", startedAt, marker: "first-a" },
      { id: "run-c", startedAt, marker: "c" },
      { id: "run-b", startedAt, marker: "b" },
      { id: "run-a", startedAt, marker: "second-a" }
    ] as const;

    const page = paginateCockpitRuns(
      runs,
      cockpitArtifactPath(".visp/runs/index.json"),
      { limit: 10 }
    );
    expect(page.runs.map(({ marker }) => marker)).toEqual(["c", "b", "second-a", "first-a"]);
  });

  it("returns a terminal empty page when a previously valid offset is beyond a shrunken index", () => {
    const runs = Array.from({ length: 10 }, (_, index) => ({
      id: `run-${index}`,
      startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }));

    const page = paginateCockpitRuns(runs, cockpitArtifactPath(".visp/runs/index.json"), {
      offset: 128,
      limit: 64
    });

    expect(page).toMatchObject({ offset: 128, limit: 64, total: 10, nextOffset: null });
    expect(page.runs).toEqual([]);
  });

  it("rejects invalid direct page bounds, timestamps, and provenance", () => {
    const sourcePath = cockpitArtifactPath(".visp/runs/index.json");
    const runs = [{ id: "run-1", startedAt: "2026-08-01T00:00:00.000Z" }];
    for (const request of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 1.5 }]) {
      expect(() => paginateCockpitRuns(runs, sourcePath, request)).toThrow(TypeError);
    }
    expect(() =>
      paginateCockpitRuns([{ id: "run-1", startedAt: "not-a-date" }], sourcePath)
    ).toThrow(TypeError);
    expect(() =>
      paginateCockpitRuns(runs, "/absolute/index.json" as CockpitArtifactPath)
    ).toThrow(TypeError);
  });
});

describe("Cockpit run-event cursors", () => {
  it("parses byte offsets and opaque generations with exact defaults", () => {
    expect(parseCockpitRunEventsRequest(new URLSearchParams())).toEqual({ offset: 0 });
    expect(
      parseCockpitRunEventsRequest(
        new URLSearchParams({ offset: "42", generation: "opaque-generation" })
      )
    ).toEqual({ offset: 42, generation: "opaque-generation" });
  });

  it.each([
    ["duplicate offset", "offset=0&offset=1"],
    ["duplicate generation", "generation=a&generation=b"],
    ["negative offset", "offset=-1"],
    ["fractional offset", "offset=1.5"],
    ["empty generation", "generation="],
    ["control generation", "generation=line%0Abreak"],
    ["unknown parameter", "limit=1"]
  ])("rejects %s", (_label, query) => {
    expect(() => parseCockpitRunEventsRequest(new URLSearchParams(query))).toThrow(
      CockpitRunsError
    );
  });
});

describe("Cockpit bounded JSONL tails", () => {
  it("uses byte offsets rather than character offsets for multibyte records", async () => {
    const projectPath = await temporaryProject("multibyte");
    const runId = "run-multibyte";
    const firstLine = eventLine(runId, "emoji 😀 and café");
    const secondLine = eventLine(runId, "second");
    await writeEvents(projectPath, runId, firstLine + secondLine);

    const first = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent,
      maxReadBytes: Buffer.byteLength(firstLine)
    });
    expect(first.events).toEqual([{ runId, message: "emoji 😀 and café" }]);
    expect(first.nextOffset).toBe(Buffer.byteLength(firstLine));
    expect(first.nextOffset).toBeGreaterThan(firstLine.length);

    const second = await tailRunEvents({
      projectPath,
      runId,
      offset: first.nextOffset,
      generation: first.generation,
      validateEvent
    });
    expect(second.events).toEqual([{ runId, message: "second" }]);
    expect(second.offset).toBe(first.nextOffset);
    expect(second.rotated).toBe(false);
  });

  it("withholds a partial suffix and returns it after append", async () => {
    const projectPath = await temporaryProject("partial");
    const runId = "run-partial";
    const firstLine = eventLine(runId, "first");
    const partial = JSON.stringify({ runId, message: "second" });
    const eventsPath = await writeEvents(projectPath, runId, firstLine + partial.slice(0, 12));

    const first = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });
    expect(first.events).toEqual([{ runId, message: "first" }]);
    expect(first.nextOffset).toBe(Buffer.byteLength(firstLine));

    await appendFile(eventsPath, `${partial.slice(12)}\n`, "utf8");
    const second = await tailRunEvents({
      projectPath,
      runId,
      offset: first.nextOffset,
      generation: first.generation,
      validateEvent
    });
    expect(second.events).toEqual([{ runId, message: "second" }]);
    expect(second.rotated).toBe(false);
  });

  it("accepts a valid first event larger than the generation fingerprint window", async () => {
    const projectPath = await temporaryProject("large-first-event");
    const runId = "run-large-first-event";
    const largeMessage = "x".repeat(128 * 1024);
    const firstLine = eventLine(runId, largeMessage);
    const eventsPath = await writeEvents(projectPath, runId, firstLine);

    const first = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });
    expect(first.events).toEqual([{ runId, message: largeMessage }]);
    expect(first.nextOffset).toBe(Buffer.byteLength(firstLine));

    await appendFile(eventsPath, eventLine(runId, "second"), "utf8");
    const second = await tailRunEvents({
      projectPath,
      runId,
      offset: first.nextOffset,
      generation: first.generation,
      validateEvent
    });
    expect(second).toMatchObject({
      events: [{ runId, message: "second" }],
      offset: first.nextOffset,
      rotated: false
    });
  });

  it("rotates after same-inode truncate and regrow even when the first event is unchanged", async () => {
    const projectPath = await temporaryProject("same-inode-regrow");
    const runId = "run-same-inode-regrow";
    const firstLine = eventLine(runId, "first unchanged");
    const oldSecondLine = eventLine(runId, "before");
    const newSecondLine = eventLine(runId, "after!");
    expect(Buffer.byteLength(newSecondLine)).toBe(Buffer.byteLength(oldSecondLine));
    const eventsPath = await writeEvents(projectPath, runId, firstLine + oldSecondLine);

    const first = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });
    await writeFile(eventsPath, firstLine + newSecondLine, "utf8");

    const rotated = await tailRunEvents({
      projectPath,
      runId,
      offset: first.nextOffset,
      generation: first.generation,
      validateEvent
    });

    expect(rotated).toMatchObject({
      events: [
        { runId, message: "first unchanged" },
        { runId, message: "after!" }
      ],
      offset: 0,
      rotated: true
    });
    expect(rotated.generation).not.toBe(first.generation);
  });

  it("rejects offsets in the middle of a complete record", async () => {
    const projectPath = await temporaryProject("boundary");
    const runId = "run-boundary";
    await writeEvents(projectPath, runId, eventLine(runId, "complete"));

    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(3),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      publicError: { error: { code: "bad_request" } }
    });
  });

  it("reports a complete record beyond the display read window as unavailable", async () => {
    const projectPath = await temporaryProject("oversized");
    const runId = "run-oversized";
    await writeEvents(projectPath, runId, eventLine(runId, "x".repeat(200)));

    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(0),
        validateEvent,
        maxReadBytes: 32
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      publicError: { error: { code: "unprocessable", artifact: { state: "unavailable" } } }
    });
    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(0),
        validateEvent,
        maxReadBytes: COCKPIT_RUN_TAIL_MAX_BYTES + 1
      })
    ).rejects.toMatchObject({ statusCode: 400, publicError: { error: { code: "bad_request" } } });
  });

  it.each([
    ["blank", "\n", "blank complete record"],
    ["malformed JSON", "{not-json}\n", "malformed JSON"],
    ["validator-invalid", `${JSON.stringify({ runId: "run-invalid", value: 1 })}\n`, "schema validation"]
  ])("rejects a %s complete line", async (_label, content, message) => {
    const projectPath = await temporaryProject(`invalid-${String(_label).replaceAll(" ", "-")}`);
    const runId = "run-invalid";
    const path = await writeEvents(projectPath, runId, content);

    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      message: expect.stringContaining(message),
      publicError: { error: { code: "unprocessable", artifact: { state: "corrupt" } } }
    });
    const descriptors = await openDescriptorsFor(path);
    if (descriptors !== null) expect(descriptors).toBe(0);
  });

  it("rejects malformed UTF-8 bytes inside an otherwise valid JSONL event string", async () => {
    const projectPath = await temporaryProject("invalid-utf8");
    const runId = "run-invalid-utf8";
    const directory = join(projectPath, ".visp", "runs", runId);
    const path = join(directory, "events.jsonl");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(`{"runId":"${runId}","message":"before`, "utf8"),
        Buffer.from([0xc3, 0x28]),
        Buffer.from(`after"}\n`, "utf8")
      ])
    );

    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      publicError: { error: { code: "unprocessable", artifact: { state: "corrupt" } } }
    });
    const descriptors = await openDescriptorsFor(path);
    if (descriptors !== null) expect(descriptors).toBe(0);
  });

  it("rejects a valid event belonging to a different run", async () => {
    const projectPath = await temporaryProject("mismatch");
    const runId = "run-requested";
    await writeEvents(projectPath, runId, eventLine("run-other", "wrong owner"));

    await expect(
      tailRunEvents({
        projectPath,
        runId,
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      publicError: { error: { code: "unprocessable", artifact: { state: "corrupt" } } }
    });
  });

  it("rejects unsafe run IDs, missing paths, nonregular files, and external symlinks", async () => {
    const projectPath = await temporaryProject("filesystem-errors");

    await expect(
      tailRunEvents({
        projectPath,
        runId: "../outside",
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({ statusCode: 400, publicError: { error: { code: "bad_request" } } });

    await expect(
      tailRunEvents({
        projectPath,
        runId: "run-missing",
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      publicError: { error: { code: "not_found", artifact: { state: "missing" } } }
    });

    const directoryPath = join(projectPath, ".visp", "runs", "run-directory", "events.jsonl");
    await mkdir(directoryPath, { recursive: true });
    await expect(
      tailRunEvents({
        projectPath,
        runId: "run-directory",
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({
      statusCode: 422,
      publicError: { error: { code: "unprocessable", artifact: { state: "unavailable" } } }
    });

    const externalRoot = await temporaryProject("external-target");
    const externalFile = join(externalRoot, "events.jsonl");
    await writeFile(externalFile, eventLine("run-symlink", "external"), "utf8");
    const symlinkDirectory = join(projectPath, ".visp", "runs", "run-symlink");
    await mkdir(symlinkDirectory, { recursive: true });
    await symlink(externalFile, join(symlinkDirectory, "events.jsonl"));
    await expect(
      tailRunEvents({
        projectPath,
        runId: "run-symlink",
        offset: cockpitByteOffset(0),
        validateEvent
      })
    ).rejects.toMatchObject({ statusCode: 403, publicError: { error: { code: "forbidden" } } });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a run-events FIFO without waiting for a writer",
    async () => {
      const projectPath = await temporaryProject("fifo");
      const runId = "run-fifo";
      const directory = join(projectPath, ".visp", "runs", runId);
      const fifoPath = join(directory, "events.jsonl");
      await mkdir(directory, { recursive: true });
      await execFileAsync("mkfifo", [fifoPath]);
      const rescue = { triggered: false };

      await expect(
        readFifoWithRescue(fifoPath, rescue, () =>
          tailRunEvents({
            projectPath,
            runId,
            offset: cockpitByteOffset(0),
            validateEvent
          })
        )
      ).rejects.toMatchObject({
        statusCode: 422,
        publicError: { error: { code: "unprocessable", artifact: { state: "unavailable" } } }
      });
      expect(rescue.triggered).toBe(false);
      const descriptors = await openDescriptorsFor(fifoPath);
      if (descriptors !== null) expect(descriptors).toBe(0);
    }
  );

  it("accepts the prior generation across append, advances it, and closes the file handle", async () => {
    const projectPath = await temporaryProject("append-generation");
    const runId = "run-append";
    const firstLine = eventLine(runId, "first");
    const path = await writeEvents(projectPath, runId, firstLine);
    const first = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });

    await appendFile(path, eventLine(runId, "second"), "utf8");
    const second = await tailRunEvents({
      projectPath,
      runId,
      offset: first.nextOffset,
      generation: first.generation,
      validateEvent
    });
    expect(second.generation).not.toBe(first.generation);
    expect(second.rotated).toBe(false);
    expect(second.events).toEqual([{ runId, message: "second" }]);
    const descriptors = await openDescriptorsFor(path);
    if (descriptors !== null) expect(descriptors).toBe(0);
  });

  it.each(["directory", "file"] as const)(
    "rejects an in-root %s symlink instead of citing alias provenance",
    async (symlinkCase) => {
      const projectPath = await temporaryProject(`inroot-symlink-${symlinkCase}`);
      const runId = "run-inroot-link";
      const physicalDirectory = join(projectPath, ".visp", "physical-events");
      const physicalEvents = join(physicalDirectory, "events.jsonl");
      const aliasDirectory = join(projectPath, ".visp", "runs", runId);
      await mkdir(physicalDirectory, { recursive: true });
      await mkdir(join(projectPath, ".visp", "runs"), { recursive: true });
      await writeFile(physicalEvents, eventLine(runId, "must not be disclosed"), "utf8");

      if (symlinkCase === "directory") {
        await symlink(physicalDirectory, aliasDirectory, "dir");
      } else {
        await mkdir(aliasDirectory);
        await symlink(physicalEvents, join(aliasDirectory, "events.jsonl"), "file");
      }

      await expect(
        tailRunEvents({
          projectPath,
          runId,
          offset: cockpitByteOffset(0),
          validateEvent
        })
      ).rejects.toMatchObject({
        statusCode: 403,
        publicError: { error: { code: "forbidden" } }
      });
    }
  );

  it("resets to zero when a known generation is truncated", async () => {
    const projectPath = await temporaryProject("truncated");
    const runId = "run-truncated";
    const firstLine = eventLine(runId, "first");
    const path = await writeEvents(projectPath, runId, firstLine + eventLine(runId, "second"));
    const initial = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });

    await writeFile(path, firstLine, "utf8");
    const reset = await tailRunEvents({
      projectPath,
      runId,
      offset: initial.nextOffset,
      generation: initial.generation,
      validateEvent
    });
    expect(reset.rotated).toBe(true);
    expect(reset.offset).toBe(0);
    expect(reset.events).toEqual([{ runId, message: "first" }]);
  });

  it("detects an equal-size rename replacement and resets generation", async () => {
    const projectPath = await temporaryProject("replacement");
    const runId = "run-replaced";
    const originalLine = eventLine(runId, "AAAA");
    const replacementLine = eventLine(runId, "BBBB");
    expect(Buffer.byteLength(replacementLine)).toBe(Buffer.byteLength(originalLine));
    const path = await writeEvents(projectPath, runId, originalLine);
    const initial = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      validateEvent
    });

    const replacementPath = join(projectPath, ".visp", "runs", runId, "replacement.jsonl");
    await writeFile(replacementPath, replacementLine, "utf8");
    await rename(replacementPath, path);
    const reset = await tailRunEvents({
      projectPath,
      runId,
      offset: initial.nextOffset,
      generation: initial.generation,
      validateEvent
    });

    expect(reset.rotated).toBe(true);
    expect(reset.offset).toBe(0);
    expect(reset.generation).not.toBe(initial.generation);
    expect(reset.events).toEqual([{ runId, message: "BBBB" }]);
  });

  it("resets when the client supplies an unrelated valid generation", async () => {
    const projectPath = await temporaryProject("generation-mismatch");
    const runId = "run-generation";
    await writeEvents(projectPath, runId, eventLine(runId, "event"));

    const result = await tailRunEvents({
      projectPath,
      runId,
      offset: cockpitByteOffset(0),
      generation: cockpitRunGeneration("unrelated-generation"),
      validateEvent
    });
    expect(result.rotated).toBe(true);
    expect(result.offset).toBe(0);
    expect(result.events).toEqual([{ runId, message: "event" }]);
  });
});
