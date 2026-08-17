// LC-97 — the top line, and the command offered under it.
//
// `Overall:` used to be a two-valued rendering of "did anything fail", so a
// report whose own body said the work here was never coordinated by Hyper was
// headed PASS. The third state is the one the reader needed: nothing is broken
// AND this report cannot be certified.

import { describe, expect, it } from "vitest";

import { formatDoctorSummary, nextCommand } from "../../../../../src/cli/commands/doctor/summary.js";
import type { DoctorCheck, DoctorSummary } from "../../../../../src/cli/commands/doctor/types.js";

function summaryOf(checks: DoctorCheck[], verdict: DoctorSummary["verdict"]): DoctorSummary {
  return {
    success: verdict === "pass",
    verdict,
    projectPath: "/repo",
    version: "0.9.0",
    checks,
    nextCommand: nextCommand(checks)
  };
}

describe("the rendered doctor summary", () => {
  it("says INCONCLUSIVE where it used to say PASS over a contradicting warning", () => {
    const rendered = formatDoctorSummary(
      summaryOf(
        [
          {
            id: "hyper-state",
            label: "Visp Hyper state",
            status: "warn",
            detail: "Hyper ran 2 work-driving verbs in this project and recorded NO session."
          }
        ],
        "inconclusive"
      )
    );

    expect(rendered).toContain("Overall: INCONCLUSIVE");
    expect(rendered, "the old rendering had no word for this state").not.toContain("Overall: PASS");
  });

  it("still says PASS and FAIL where those are the truth", () => {
    expect(formatDoctorSummary(summaryOf([], "pass"))).toContain("Overall: PASS");
    expect(formatDoctorSummary(summaryOf([], "fail"))).toContain("Overall: FAIL");
  });
});

describe("the next command doctor offers", () => {
  it("prefers a failure's remedy over everything else", () => {
    expect(
      nextCommand([
        { id: "hyper-state", label: "s", status: "warn", detail: "d", recovery: "visp work" },
        { id: "mcp", label: "m", status: "fail", detail: "d", recovery: "visp doctor --json" }
      ])
    ).toBe("visp doctor --json");
  });

  it("offers the warning that is holding the verdict down, not the one printed first", () => {
    // An advisory warning listed above a verdict-bearing one used to win on
    // position alone, so the reader was sent to fix a capability while the
    // finding that made the report inconclusive stayed untouched.
    expect(
      nextCommand([
        { id: "memory", label: "Memory", status: "warn", detail: "d", recovery: "visp init --memory-mode llm-memory" },
        { id: "hyper-state", label: "State", status: "warn", detail: "d", recovery: "visp work" }
      ])
    ).toBe("visp work");
  });

  it("falls back to an advisory remedy when nothing bears on the verdict", () => {
    expect(
      nextCommand([
        { id: "memory", label: "Memory", status: "warn", detail: "d", recovery: "visp init --memory-mode llm-memory" }
      ])
    ).toBe("visp init --memory-mode llm-memory");
  });
});
