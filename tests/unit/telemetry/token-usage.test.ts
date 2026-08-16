import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasObservedTokens,
  parseTokenCount,
  reportedUsageNote,
  unreportedUsageNote,
  unreportedUsageWarning
} from "../../../src/telemetry/token-usage.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseTokenCount", () => {
  it("returns undefined for an absent value without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTokenCount(undefined, "input-tokens")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses a clean integer, including a surrounding-whitespace form", () => {
    expect(parseTokenCount("1200", "input-tokens")).toBe(1200);
    expect(parseTokenCount(" 42 ", "input-tokens")).toBe(42);
    expect(parseTokenCount("0", "input-tokens")).toBe(0);
  });

  it("warns and ignores anything that is not a clean non-negative integer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["-5", "1.5", "1e3", "abc", "", "12abc"]) {
      expect(parseTokenCount(raw, "output-tokens")).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn.mock.calls[0]?.[0]).toContain("--output-tokens");
  });
});

describe("hasObservedTokens", () => {
  it("is false when the host reported nothing", () => {
    expect(hasObservedTokens({})).toBe(false);
  });

  it("is true when either count carries real usage", () => {
    expect(hasObservedTokens({ inputTokens: 1200 })).toBe(true);
    expect(hasObservedTokens({ outputTokens: 300 })).toBe(true);
    expect(hasObservedTokens({ inputTokens: 1200, outputTokens: 300 })).toBe(true);
  });

  it("counts a reported zero on one side as observed when the other side is real", () => {
    // Kit records against the total, so 0 input with real output is a valid row.
    expect(hasObservedTokens({ inputTokens: 0, outputTokens: 300 })).toBe(true);
  });

  it("is false when the reported total is zero", () => {
    // Kit rejects `--record-usage` with a total of zero ("requires
    // --input-tokens, --output-tokens, or --total-tokens"). Treating an
    // all-zero report as observed would send a write Kit refuses, and the task
    // would then close with neither a real row nor a recorded absence.
    expect(hasObservedTokens({ inputTokens: 0, outputTokens: 0 })).toBe(false);
    expect(hasObservedTokens({ inputTokens: 0 })).toBe(false);
    expect(hasObservedTokens({ outputTokens: 0 })).toBe(false);
  });
});

describe("usage notes", () => {
  it("states the true reason for an absent count and names the repair", () => {
    const note = unreportedUsageNote("visp save", "T001");
    expect(note).toContain("no usable token usage reached this invocation");
    // True for both paths that land here: nothing passed, and a zero total.
    expect(note).toContain("summed to zero");
    expect(note).toContain("--input-tokens");
    expect(note).toContain("--output-tokens");
    expect(note).toContain("T001");
  });

  it("never claims the coordinator is unable to observe usage", () => {
    // The regression this whole change exists to prevent: the old note asserted
    // an incapacity that was false twice over, and 38 rows inherited it.
    for (const text of [
      unreportedUsageNote("visp save", "T001"),
      unreportedUsageWarning("visp save", "T001"),
      reportedUsageNote("visp save")
    ]) {
      expect(text).not.toMatch(/cannot observe/iu);
      expect(text).not.toMatch(/unable to observe/iu);
    }
  });

  it("attributes a recorded row to the host that reported it", () => {
    expect(reportedUsageNote("visp save")).toContain("as reported by the agent host");
  });

  it("warns loudly enough to be actionable, naming the task and the supersede path", () => {
    const warning = unreportedUsageWarning("visp save", "T007");
    expect(warning).toContain("T007");
    expect(warning).toContain("--input-tokens");
    expect(warning).toContain("supersedes");
  });
});
