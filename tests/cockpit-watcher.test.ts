import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startCockpitWatcher,
  type CockpitWatchFactory
} from "../src/cockpit/watcher.js";

type CockpitWatcher = Awaited<ReturnType<typeof startCockpitWatcher>>;

const temporaryDirectories = new Set<string>();
const openWatchers = new Set<CockpitWatcher>();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled([...openWatchers].map((watcher) => watcher.close()));
  openWatchers.clear();
  await Promise.allSettled(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

class FakeFsWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

function fakeWatchHarness(failingAttempts: readonly number[] = []) {
  const failures = new Set(failingAttempts);
  const calls: Array<{
    path: string;
    recursive: boolean;
    listener: Parameters<CockpitWatchFactory>[2];
    watcher?: FakeFsWatcher;
  }> = [];
  const factory: CockpitWatchFactory = (path, options, listener) => {
    const attempt = calls.length + 1;
    const call: (typeof calls)[number] = {
      path,
      recursive: options.recursive === true,
      listener
    };
    calls.push(call);
    if (failures.has(attempt)) throw new Error(`watch attempt ${attempt} failed`);
    const watcher = new FakeFsWatcher();
    call.watcher = watcher;
    return watcher as unknown as FSWatcher;
  };
  return { calls, factory };
}

async function flushRealIo(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

async function waitForPredicate(
  predicate: () => boolean,
  description: string,
  timeoutMs = 3_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flushRealIo();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function temporaryProject(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "visp-cockpit-watcher-"));
  temporaryDirectories.add(path);
  return path;
}

function invalidationRecorder() {
  const paths: string[] = [];
  const waiters = new Set<{
    afterIndex: number;
    predicate: (path: string) => boolean;
    resolve: (path: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  const onInvalidate = (path: string): void => {
    paths.push(path);
    for (const waiter of waiters) {
      if (paths.length <= waiter.afterIndex || !waiter.predicate(path)) continue;
      clearTimeout(waiter.timeout);
      waiters.delete(waiter);
      waiter.resolve(path);
    }
  };

  const waitFor = (
    predicate: (path: string) => boolean,
    afterIndex = paths.length
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      const waiter = {
        afterIndex,
        predicate,
        resolve,
        reject,
        timeout: setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for Cockpit invalidation after: ${paths.join(", ")}`));
        }, 3_000)
      };
      waiters.add(waiter);
    });

  const close = (): void => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Invalidation recorder closed."));
    }
    waiters.clear();
  };

  return { paths, onInvalidate, waitFor, close };
}

async function start(
  projectPath: string,
  recorder: ReturnType<typeof invalidationRecorder>,
  coalesceMs = 10
): Promise<CockpitWatcher> {
  const watcher = await startCockpitWatcher({
    projectPath,
    coalesceMs,
    onInvalidate: recorder.onInvalidate
  });
  openWatchers.add(watcher);
  return watcher;
}

describe("Cockpit recursive artifact watcher", () => {
  it("fails startup and closes the root watcher when recursive arming fails", async () => {
    const projectPath = await temporaryProject();
    await mkdir(join(projectPath, ".visp"));
    const harness = fakeWatchHarness([2]);

    await expect(
      startCockpitWatcher({
        projectPath,
        watchFactory: harness.factory,
        onInvalidate: () => undefined
      })
    ).rejects.toThrow("watch attempt 2 failed");

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0]?.watcher?.closed).toBe(true);
  });

  it("recovers an artifact watcher after one delayed retry and closes the event gap", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const projectPath = await temporaryProject();
    await mkdir(join(projectPath, ".visp"));
    const harness = fakeWatchHarness();
    const invalidations: string[] = [];
    const errors: Error[] = [];
    const watcher = await startCockpitWatcher({
      projectPath,
      watchFactory: harness.factory,
      retryMs: 20,
      coalesceMs: 1,
      onInvalidate: (path) => invalidations.push(path),
      onError: (error) => errors.push(error)
    });
    openWatchers.add(watcher);
    const root = harness.calls[0]?.watcher;
    const artifact = harness.calls[1]?.watcher;

    artifact?.emit("error", new Error("artifact watcher failed"));
    expect(artifact?.closed).toBe(true);
    expect(root?.closed).toBe(false);
    expect(errors.map((error) => error.message)).toEqual(["artifact watcher failed"]);
    expect(harness.calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(20);
    await waitForPredicate(() => harness.calls.length >= 3, "the recursive watcher to re-arm");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.calls).toHaveLength(3);
    expect(harness.calls[2]?.recursive).toBe(true);
    expect(invalidations).toContain(".visp");

    harness.calls[2]?.listener("change", "status.json");
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidations).toContain(".visp/status.json");
  });

  it("recreates both handles after a root error and cancels a pending retry on close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const projectPath = await temporaryProject();
    await mkdir(join(projectPath, ".visp"));
    const harness = fakeWatchHarness();
    const invalidations: string[] = [];
    const watcher = await startCockpitWatcher({
      projectPath,
      watchFactory: harness.factory,
      retryMs: 20,
      coalesceMs: 1,
      onInvalidate: (path) => invalidations.push(path)
    });
    openWatchers.add(watcher);
    const oldRoot = harness.calls[0]?.watcher;
    const oldArtifact = harness.calls[1]?.watcher;

    oldRoot?.emit("error", new Error("root watcher failed"));
    expect(oldRoot?.closed).toBe(true);
    expect(oldArtifact?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    await waitForPredicate(() => harness.calls.length >= 4, "both watcher handles to re-arm");
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.calls).toHaveLength(4);
    expect(harness.calls.slice(2).map((call) => call.recursive)).toEqual([false, true]);
    expect(invalidations).toContain(".visp");

    const recoveredRoot = harness.calls[2]?.watcher;
    recoveredRoot?.emit("error", new Error("second root failure"));
    const attemptsBeforeClose = harness.calls.length;
    await watcher.close();
    openWatchers.delete(watcher);
    await vi.advanceTimersByTimeAsync(100);
    await flushRealIo();
    expect(harness.calls).toHaveLength(attemptsBeforeClose);

    oldRoot?.emit("error", new Error("stale callback"));
    expect(harness.calls).toHaveLength(attemptsBeforeClose);
  });

  it("emits recursive repository-relative POSIX paths and never file payloads", async () => {
    const projectPath = await temporaryProject();
    const nestedPath = join(projectPath, ".visp", "features", "001-cockpit", "status.json");
    await mkdir(join(projectPath, ".visp", "features", "001-cockpit"), { recursive: true });
    const recorder = invalidationRecorder();
    await start(projectPath, recorder);
    const event = recorder.waitFor((path) => path === ".visp/features/001-cockpit/status.json");
    const payload = "WATCHER_PAYLOAD_MUST_NOT_LEAK";

    await writeFile(nestedPath, payload, "utf8");

    expect(await event).toBe(".visp/features/001-cockpit/status.json");
    expect(recorder.paths.every((path) => !path.includes("\\"))).toBe(true);
    expect(recorder.paths.join("\n")).not.toContain(payload);
    recorder.close();
  });

  it("excludes only the .visp/cache subtree", async () => {
    const projectPath = await temporaryProject();
    const cachePath = join(projectPath, ".visp", "cache", "nested");
    const visiblePath = join(projectPath, ".visp", "cacheish");
    await mkdir(cachePath, { recursive: true });
    await mkdir(visiblePath, { recursive: true });
    const recorder = invalidationRecorder();
    await start(projectPath, recorder);
    const visibleEvent = recorder.waitFor((path) => path === ".visp/cacheish/visible.json");

    await writeFile(join(cachePath, "ignored.json"), '{"ignored":true}\n', "utf8");
    await writeFile(join(visiblePath, "visible.json"), '{"visible":true}\n', "utf8");

    expect(await visibleEvent).toBe(".visp/cacheish/visible.json");
    expect(recorder.paths.some((path) => path === ".visp/cache" || path.startsWith(".visp/cache/"))).toBe(
      false
    );
    recorder.close();
  });

  it("coalesces repeated invalidations for the same artifact", async () => {
    const projectPath = await temporaryProject();
    const artifactPath = join(projectPath, ".visp", "status.json");
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(artifactPath, "initial\n", "utf8");
    const recorder = invalidationRecorder();
    await start(projectPath, recorder, 50);
    const firstEvent = recorder.waitFor((path) => path === ".visp/status.json");

    await Promise.all(
      Array.from({ length: 12 }, (_, index) => appendFile(artifactPath, `change-${index}\n`, "utf8"))
    );
    await firstEvent;

    const barrierPath = join(projectPath, ".visp", "coalesce-barrier.json");
    const barrierEvent = recorder.waitFor((path) => path === ".visp/coalesce-barrier.json");
    await writeFile(barrierPath, "{}\n", "utf8");
    await barrierEvent;

    expect(recorder.paths.filter((path) => path === ".visp/status.json")).toHaveLength(1);
    recorder.close();
  });

  it("arms recursive watching after an initially absent .visp directory is created", async () => {
    const projectPath = await temporaryProject();
    const recorder = invalidationRecorder();
    await start(projectPath, recorder);
    const rootEvent = recorder.waitFor((path) => path === ".visp");

    await mkdir(join(projectPath, ".visp"));
    expect(await rootEvent).toBe(".visp");

    const nestedEvent = recorder.waitFor((path) => path === ".visp/runs/run-0001/events.jsonl");
    await mkdir(join(projectPath, ".visp", "runs", "run-0001"), { recursive: true });
    await writeFile(
      join(projectPath, ".visp", "runs", "run-0001", "events.jsonl"),
      "{}\n",
      "utf8"
    );
    expect(await nestedEvent).toBe(".visp/runs/run-0001/events.jsonl");
    recorder.close();
  });

  it("closes idempotently and never calls the old listener after close", async () => {
    const projectPath = await temporaryProject();
    await mkdir(join(projectPath, ".visp"));
    const closedRecorder = invalidationRecorder();
    const closedWatcher = await start(projectPath, closedRecorder);

    await Promise.all([closedWatcher.close(), closedWatcher.close()]);
    openWatchers.delete(closedWatcher);
    const baseline = closedRecorder.paths.length;

    const activeRecorder = invalidationRecorder();
    const activeWatcher = await start(projectPath, activeRecorder);
    const activeEvent = activeRecorder.waitFor((path) => path === ".visp/after-close.json");
    await writeFile(join(projectPath, ".visp", "after-close.json"), "{}\n", "utf8");
    expect(await activeEvent).toBe(".visp/after-close.json");
    expect(closedRecorder.paths).toHaveLength(baseline);

    await activeWatcher.close();
    openWatchers.delete(activeWatcher);
    closedRecorder.close();
    activeRecorder.close();
  });

  it.each([-1, 1.5, 10_001, Number.NaN])("rejects invalid coalesceMs %s", async (coalesceMs) => {
    const projectPath = await temporaryProject();
    await expect(
      startCockpitWatcher({ projectPath, coalesceMs, onInvalidate: () => undefined })
    ).rejects.toThrow(/coalesceMs|integer/u);
  });
});
