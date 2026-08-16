import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COCKPIT_API_VERSION,
  cockpitArtifactPath,
  type CockpitInvalidationV1
} from "../../../src/cockpit/contracts.js";
import {
  createCockpitSseBroadcaster,
  type CockpitSseWritable
} from "../../../src/cockpit/sse.js";

class FakeSseWritable extends EventEmitter {
  readonly writes: string[] = [];
  endCalls = 0;
  destroyed = false;
  writableEnded = false;
  private readonly writeResults: boolean[];

  constructor(writeResults: boolean[] = []) {
    super();
    this.writeResults = [...writeResults];
  }

  write(chunk: string | Uint8Array): boolean {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return this.writeResults.shift() ?? true;
  }

  end(): this {
    this.endCalls += 1;
    this.writableEnded = true;
    return this;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

function asSseWritable(client: FakeSseWritable): CockpitSseWritable {
  return client as unknown as CockpitSseWritable;
}

function records(client: FakeSseWritable): string[] {
  return client.writes
    .join("")
    .replaceAll("\r\n", "\n")
    .split("\n\n")
    .filter((record) => record.length > 0);
}

function invalidationRecords(client: FakeSseWritable): string[] {
  return records(client).filter((record) => record.split("\n").includes("event: invalidation"));
}

function parseInvalidation(record: string): CockpitInvalidationV1 {
  const data = record
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  return JSON.parse(data) as CockpitInvalidationV1;
}

describe("Cockpit SSE invalidation broadcaster", () => {
  it("sends an exact path-only CockpitInvalidationV1 without artifact payload bytes", () => {
    const broadcaster = createCockpitSseBroadcaster();
    const client = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(client));
    const artifactPayload = "ARTIFACT_BYTES_MUST_NEVER_APPEAR_ON_SSE";

    broadcaster.invalidate(cockpitArtifactPath(".visp/features/001-cockpit/status.json"));

    expect(invalidationRecords(client)).toHaveLength(1);
    const record = invalidationRecords(client)[0]!;
    expect(record).toBe(
      `event: invalidation\ndata: ${JSON.stringify({
        apiVersion: COCKPIT_API_VERSION,
        type: "invalidation",
        path: ".visp/features/001-cockpit/status.json"
      })}`
    );
    expect(parseInvalidation(record)).toStrictEqual({
      apiVersion: COCKPIT_API_VERSION,
      type: "invalidation",
      path: ".visp/features/001-cockpit/status.json"
    });
    expect(Object.keys(parseInvalidation(record)).sort()).toEqual(["apiVersion", "path", "type"]);
    expect(client.writes.join("\n")).not.toContain(artifactPayload);

    broadcaster.close();
  });

  it("accepts the .visp root invalidation but rejects forged unsafe paths at runtime", () => {
    const broadcaster = createCockpitSseBroadcaster();
    const client = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(client));

    broadcaster.invalidate(".visp");
    expect(parseInvalidation(invalidationRecords(client)[0]!)).toStrictEqual({
      apiVersion: COCKPIT_API_VERSION,
      type: "invalidation",
      path: ".visp"
    });

    for (const path of [
      ".visp/../outside.json",
      ".visp/status.json\n\ndata: forged",
      "/absolute/.visp/status.json"
    ]) {
      expect(() =>
        broadcaster.invalidate(path as CockpitInvalidationV1["path"])
      ).toThrow(TypeError);
    }
    expect(invalidationRecords(client)).toHaveLength(1);

    broadcaster.close();
  });

  it("broadcasts independently to multiple clients and cleans up close, error, and detach", () => {
    const broadcaster = createCockpitSseBroadcaster();
    const closedClient = new FakeSseWritable();
    const erroredClient = new FakeSseWritable();
    const detachedClient = new FakeSseWritable();
    const activeClient = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(closedClient));
    broadcaster.addClient(asSseWritable(erroredClient));
    const detach = broadcaster.addClient(asSseWritable(detachedClient));
    broadcaster.addClient(asSseWritable(activeClient));

    closedClient.emit("close");
    erroredClient.emit("error", new Error("client disconnected"));
    detach();
    expect(() => detach()).not.toThrow();
    broadcaster.invalidate(cockpitArtifactPath(".visp/status.json"));

    expect(invalidationRecords(closedClient)).toHaveLength(0);
    expect(invalidationRecords(erroredClient)).toHaveLength(0);
    expect(invalidationRecords(detachedClient)).toHaveLength(0);
    expect(invalidationRecords(activeClient)).toHaveLength(1);

    broadcaster.close();
  });

  it("closes idempotently, sends nothing after close, and immediately ends later clients", () => {
    const broadcaster = createCockpitSseBroadcaster();
    const existingClient = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(existingClient));
    const beforeCloseWrites = existingClient.writes.length;

    expect(() => broadcaster.close()).not.toThrow();
    expect(() => broadcaster.close()).not.toThrow();
    expect(existingClient.endCalls).toBe(1);
    broadcaster.invalidate(cockpitArtifactPath(".visp/after-close.json"));
    expect(existingClient.writes).toHaveLength(beforeCloseWrites);

    const lateClient = new FakeSseWritable();
    const detachLateClient = broadcaster.addClient(asSseWritable(lateClient));
    expect(lateClient.endCalls).toBe(1);
    expect(lateClient.writes).toHaveLength(0);
    expect(() => detachLateClient()).not.toThrow();
    expect(() => detachLateClient()).not.toThrow();
    broadcaster.invalidate(cockpitArtifactPath(".visp/still-closed.json"));
    expect(lateClient.writes).toHaveLength(0);
  });

  it("emits comment-only keepalives and stops their timer on close", () => {
    vi.useFakeTimers();
    const broadcaster = createCockpitSseBroadcaster({ keepAliveMs: 100 });
    const client = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(client));
    const initialRecords = records(client).length;

    vi.advanceTimersByTime(300);

    const keepalives = records(client).slice(initialRecords);
    expect(keepalives).toHaveLength(3);
    for (const keepalive of keepalives) {
      expect(keepalive).toMatch(/^:/u);
      expect(keepalive).not.toMatch(/^(?:data|event):/mu);
    }

    broadcaster.close();
    const writesAfterClose = client.writes.length;
    vi.advanceTimersByTime(1_000);
    expect(client.writes).toHaveLength(writesAfterClose);
  });

  it.each([-1, 0, 1.5, 120_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid keepAliveMs %s",
    (keepAliveMs) => {
      expect(() => createCockpitSseBroadcaster({ keepAliveMs })).toThrow(TypeError);
    }
  );

  it("coalesces a blocked client's pending work without delaying healthy clients", () => {
    const broadcaster = createCockpitSseBroadcaster();
    // The initial connected comment is accepted into the buffer but reports backpressure.
    const blockedClient = new FakeSseWritable([false]);
    const healthyClient = new FakeSseWritable();
    broadcaster.addClient(asSseWritable(blockedClient));
    broadcaster.addClient(asSseWritable(healthyClient));
    const paths = [
      cockpitArtifactPath(".visp/one.json"),
      cockpitArtifactPath(".visp/two.json"),
      cockpitArtifactPath(".visp/three.json")
    ];

    for (const path of paths) broadcaster.invalidate(path);

    expect(invalidationRecords(blockedClient)).toHaveLength(0);
    expect(invalidationRecords(healthyClient).map(parseInvalidation)).toEqual(
      paths.map((path) => ({ apiVersion: COCKPIT_API_VERSION, type: "invalidation", path }))
    );

    blockedClient.emit("drain");
    const drainedInvalidations = invalidationRecords(blockedClient);
    expect(drainedInvalidations).toHaveLength(1);
    expect(paths).toContain(parseInvalidation(drainedInvalidations[0]!).path);

    broadcaster.invalidate(cockpitArtifactPath(".visp/after-drain.json"));
    expect(invalidationRecords(blockedClient)).toHaveLength(2);
    expect(parseInvalidation(invalidationRecords(blockedClient)[1]!)).toStrictEqual({
      apiVersion: COCKPIT_API_VERSION,
      type: "invalidation",
      path: ".visp/after-drain.json"
    });

    broadcaster.close();
  });
});
