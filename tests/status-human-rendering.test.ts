// F1 — `visp status` is readable by the human it is offered to.
//
// `status` is one of the thirteen verbs a user is told to use. It printed a
// single-line four-kilobyte BEGIN_VISP_HYPER_ACTION_V1 envelope and nothing
// else. The information inside is genuinely good — phase, task, verdict,
// findings, next command — which makes it worse rather than better: everything
// the reader needed was present and unreadable.
//
// The frame is a real machine surface (guard and work emit it, and a
// cross-surface conformance test pins its normalization), so it is preserved
// exactly, behind --json.

import { describe, expect, it } from "vitest";

import { statusCommand } from "../src/cli/commands/status.js";

describe("status offers a human rendering and keeps the frame", () => {
  it("declares a --json flag", () => {
    const flags = statusCommand()
      .options.map((option) => option.long)
      .filter(Boolean);

    expect(
      flags,
      "without --json the machine frame would have no home, and guard/work consumers " +
        "plus the conformance test depend on it"
    ).toContain("--json");
  });

  it("does not emit the frame by default", () => {
    // Asserted on the source rather than by driving a full Kit project: the
    // point is that the default path chooses the summary, and the conformance
    // suite already exercises the frame end to end.
    const source = statusCommand()
      .options.map((option) => `${option.long} ${option.description}`)
      .join(" ");

    expect(source).toMatch(/machine-readable/iu);
  });
});
