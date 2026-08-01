import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COCKPIT_API_PATHS,
  COCKPIT_API_VERSION,
  COCKPIT_ERROR_MESSAGE_MAX_LENGTH,
  COCKPIT_MEMORY_ARTIFACT_PATHS,
  COCKPIT_RUN_GENERATION_MAX_LENGTH,
  cockpitApiError,
  cockpitArtifactPath,
  cockpitByteOffset,
  cockpitRunEventsPath,
  cockpitRunGeneration,
  cockpitRunsPagePath,
  isCockpitArtifactPath,
  type CockpitApiErrorArtifact,
  type CockpitArtifactPath,
  type CockpitByteOffset,
  type CockpitMemoryArtifactPath,
  type CockpitPresentArtifact,
  type CockpitRunEventsPageV1,
  type CockpitRunGeneration,
  type CockpitRunsPageV1,
  type CockpitScreen
} from "../src/cockpit/contracts.js";

const statusPath = cockpitArtifactPath(".visp/status.json");
const eventsPath = cockpitArtifactPath(".visp/runs/run-0001/events.jsonl");

describe("Cockpit artifact path contract", () => {
  it("brands repository-relative POSIX paths below .visp", () => {
    for (const path of [
      ".visp/status.json",
      ".visp/runs/run-0001/events.jsonl",
      ".visp/memory/.index"
    ]) {
      expect(isCockpitArtifactPath(path), path).toBe(true);
      expect(cockpitArtifactPath(path)).toBe(path);
    }

    expectTypeOf(statusPath).toMatchTypeOf<CockpitArtifactPath>();
  });

  it.each([
    ["empty", ""],
    ["root without a descendant", ".visp"],
    ["empty terminal segment", ".visp/"],
    ["absolute POSIX", "/.visp/status.json"],
    ["absolute Windows", "C:\\workspace\\.visp\\status.json"],
    ["backslash", ".visp\\status.json"],
    ["empty segment", ".visp/runs//events.jsonl"],
    ["dot segment", ".visp/./status.json"],
    ["parent segment", ".visp/runs/../status.json"],
    ["NUL control", ".visp/status\u0000.json"],
    ["newline control", ".visp/status\n.json"],
    ["DEL control", ".visp/status\u007f.json"],
    ["query", ".visp/status.json?raw=1"],
    ["fragment", ".visp/status.json#section"],
    ["percent encoding", ".visp/%2e%2e/status.json"]
  ])("rejects %s paths", (_label, path) => {
    expect(isCockpitArtifactPath(path)).toBe(false);
    expect(() => cockpitArtifactPath(path)).toThrow(TypeError);
  });

  it("rejects non-string values at the runtime guard", () => {
    for (const value of [undefined, null, 0, {}, []]) {
      expect(isCockpitArtifactPath(value)).toBe(false);
    }
  });
});

describe("Cockpit screen shape contract", () => {
  it("requires a nonempty per-artifact view tuple", () => {
    const screen = {
      id: "now",
      label: "Now",
      artifacts: [
        {
          id: "status",
          label: "Status",
          state: "present",
          sourcePath: statusPath,
          values: [{ label: "Phase", value: 9, sourcePath: statusPath }]
        }
      ]
    } as const satisfies CockpitScreen<"now">;

    expect(screen.artifacts).toHaveLength(1);
    expectTypeOf(screen).toMatchTypeOf<CockpitScreen<"now">>();

    const invalidEmptyScreen = {
      id: "now",
      label: "Now",
      // @ts-expect-error Cockpit screens require at least one artifact view.
      artifacts: []
    } as const satisfies CockpitScreen<"now">;
    expect(invalidEmptyScreen.artifacts).toHaveLength(0);
  });

  it("restricts Memory provenance to the three approved artifact paths", () => {
    expect(COCKPIT_MEMORY_ARTIFACT_PATHS).toEqual([
      ".visp/memory/constitution.md",
      ".visp/memory/patterns.md",
      ".visp/memory/project-summary.md"
    ]);
    for (const path of COCKPIT_MEMORY_ARTIFACT_PATHS) {
      expect(isCockpitArtifactPath(path)).toBe(true);
      expectTypeOf(path).toMatchTypeOf<CockpitMemoryArtifactPath>();
    }

    expectTypeOf<CockpitPresentArtifact<CockpitMemoryArtifactPath>["sourcePath"]>()
      .toEqualTypeOf<CockpitMemoryArtifactPath>();

    // @ts-expect-error A valid general artifact path is not automatically trusted Memory provenance.
    const invalidMemoryPath: CockpitMemoryArtifactPath = statusPath;
    expect(invalidMemoryPath).toBe(statusPath);
  });
});

describe("Cockpit pagination primitives and route helpers", () => {
  it("accepts only non-negative safe byte offsets", () => {
    expect(cockpitByteOffset(0)).toBe(0);
    expect(cockpitByteOffset(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expectTypeOf(cockpitByteOffset(0)).toEqualTypeOf<CockpitByteOffset>();

    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cockpitByteOffset(value), String(value)).toThrow(TypeError);
    }
  });

  it("accepts bounded nonempty opaque generations and rejects controls", () => {
    expect(cockpitRunGeneration("generation-1")).toBe("generation-1");
    expect(cockpitRunGeneration("g".repeat(COCKPIT_RUN_GENERATION_MAX_LENGTH))).toHaveLength(
      COCKPIT_RUN_GENERATION_MAX_LENGTH
    );
    expectTypeOf(cockpitRunGeneration("generation-1")).toEqualTypeOf<CockpitRunGeneration>();

    for (const value of [
      "",
      "g".repeat(COCKPIT_RUN_GENERATION_MAX_LENGTH + 1),
      "generation\u0000",
      "generation\n",
      "generation\u007f"
    ]) {
      expect(() => cockpitRunGeneration(value)).toThrow(TypeError);
    }
  });

  it("constructs canonical runs and run-event routes", () => {
    expect(COCKPIT_API_PATHS.runs).toBe("/api/runs");
    expect(cockpitRunsPagePath()).toBe("/api/runs?offset=0&limit=64");
    expect(cockpitRunsPagePath({ offset: 5, limit: 20 })).toBe("/api/runs?offset=5&limit=20");
    expect(cockpitRunEventsPath("run-0001", { offset: cockpitByteOffset(0) })).toBe(
      "/api/runs/run-0001/events?offset=0"
    );
    expect(
      cockpitRunEventsPath("run_0001", {
        offset: cockpitByteOffset(42),
        generation: cockpitRunGeneration("opaque value/+?")
      })
    ).toBe("/api/runs/run_0001/events?offset=42&generation=opaque+value%2F%2B%3F");
  });

  it("rejects invalid pagination and unsafe run identifiers", () => {
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cockpitRunsPagePath({ offset })).toThrow(TypeError);
    }
    for (const limit of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => cockpitRunsPagePath({ limit })).toThrow(TypeError);
    }
    for (const runId of ["", ".", "..", "../run", "runs/run", "run\\events", "run\u0000id"]) {
      expect(() => cockpitRunEventsPath(runId, { offset: cockpitByteOffset(0) })).toThrow();
    }
  });
});

describe("Cockpit response provenance and pagination shape", () => {
  it("requires provenance and nullable nextOffset on runs pages", () => {
    const page = {
      apiVersion: COCKPIT_API_VERSION,
      kind: "runs-page",
      sourcePath: cockpitArtifactPath(".visp/runs/index.json"),
      runs: [{ id: "run-0001" }],
      offset: 0,
      limit: 1,
      total: 2,
      nextOffset: 1
    } as const satisfies CockpitRunsPageV1<{ readonly id: string }>;
    const terminalPage: CockpitRunsPageV1 = { ...page, runs: [], offset: 2, nextOffset: null };

    expect(page.sourcePath).toBe(".visp/runs/index.json");
    expect(page.nextOffset).toBe(1);
    expect(terminalPage.nextOffset).toBeNull();
    expectTypeOf<CockpitRunsPageV1["sourcePath"]>().toEqualTypeOf<CockpitArtifactPath>();
    expectTypeOf<CockpitRunsPageV1["nextOffset"]>().toEqualTypeOf<number | null>();
  });

  it("requires run-event provenance and an exact non-null byte nextOffset", () => {
    const page = {
      apiVersion: COCKPIT_API_VERSION,
      kind: "run-events-page",
      runId: "run-0001",
      sourcePath: eventsPath,
      events: [{ type: "checkpoint" }],
      offset: cockpitByteOffset(16),
      nextOffset: cockpitByteOffset(80),
      rotated: false,
      generation: cockpitRunGeneration("generation-1")
    } as const satisfies CockpitRunEventsPageV1<{ readonly type: string }>;

    expect(page).toMatchObject({
      runId: "run-0001",
      sourcePath: ".visp/runs/run-0001/events.jsonl",
      offset: 16,
      nextOffset: 80,
      generation: "generation-1"
    });
    expectTypeOf<CockpitRunEventsPageV1["sourcePath"]>().toEqualTypeOf<CockpitArtifactPath>();
    expectTypeOf<CockpitRunEventsPageV1["nextOffset"]>().toEqualTypeOf<CockpitByteOffset>();
  });
});

describe("Cockpit bounded error envelopes", () => {
  it("trims, bounds, defaults, and freezes public error messages", () => {
    const bounded = cockpitApiError(
      "bad_request",
      `  ${"x".repeat(COCKPIT_ERROR_MESSAGE_MAX_LENGTH + 20)}  `
    );
    const fallback = cockpitApiError("internal_error", "   ");

    expect(bounded).toEqual({
      apiVersion: COCKPIT_API_VERSION,
      kind: "error",
      error: {
        code: "bad_request",
        message: "x".repeat(COCKPIT_ERROR_MESSAGE_MAX_LENGTH)
      }
    });
    expect(fallback.error.message).toBe("Cockpit request failed.");
    expect(Object.isFrozen(bounded)).toBe(true);
    expect(Object.isFrozen(bounded.error)).toBe(true);
  });

  it("allows only bounded artifact states and requires degraded provenance", () => {
    const missing: CockpitApiErrorArtifact = {
      state: "missing",
      expectedPath: statusPath
    };
    const corrupt: CockpitApiErrorArtifact = {
      state: "corrupt",
      expectedPath: statusPath,
      sourcePath: statusPath
    };

    const missingError = cockpitApiError("not_found", "Missing", missing);
    const corruptError = cockpitApiError("unprocessable", "Corrupt", corrupt);
    expect(missingError.error.artifact).toEqual(missing);
    expect(corruptError.error.artifact).toEqual(corrupt);
    expect(Object.isFrozen(corruptError.error.artifact)).toBe(true);
    expectTypeOf<CockpitApiErrorArtifact["state"]>().toEqualTypeOf<
      "uninitialized" | "missing" | "unavailable" | "stale" | "corrupt"
    >();
    expectTypeOf<Extract<CockpitApiErrorArtifact, { sourcePath: CockpitArtifactPath }>>()
      .toMatchTypeOf<{ sourcePath: CockpitArtifactPath }>();
  });

  it("rejects malformed artifact provenance even if a caller bypasses TypeScript", () => {
    expect(() =>
      cockpitApiError("not_found", "Missing", {
        state: "missing",
        expectedPath: "/absolute/status.json" as CockpitArtifactPath
      })
    ).toThrow(TypeError);
    expect(() =>
      cockpitApiError("unprocessable", "Corrupt", {
        state: "corrupt",
        expectedPath: statusPath
      } as CockpitApiErrorArtifact)
    ).toThrow(TypeError);
    expect(() =>
      cockpitApiError("unprocessable", "Unexpected state", {
        state: "present",
        expectedPath: statusPath,
        sourcePath: statusPath
      } as unknown as CockpitApiErrorArtifact)
    ).toThrow(TypeError);
  });
});
