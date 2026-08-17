// LC-97 — `Overall:` answers for the warnings that contradict it.
//
// The reported run printed:
//
//   Overall: PASS
//   [WARN] Visp Hyper state: Hyper ran 2 work-driving verbs in this project and
//   recorded NO session … whatever was built here was not coordinated by Hyper.
//
// Both sentences were about the same project. A reader or an orchestrator
// taking the top line got the opposite of the report underneath it, because
// `Overall` summed failures only and no warning could ever reach it.
//
// These tests pin the rule rather than the individual checks: what makes a
// warning verdict-bearing, what makes one advisory, and which way an
// unclassified check falls.

import { describe, expect, it } from "vitest";

import type { DoctorCheck } from "../../../../../src/cli/commands/doctor/types.js";
import { doctorVerdict, isVerdictBearing } from "../../../../../src/cli/commands/doctor/verdict.js";

function check(id: string, status: DoctorCheck["status"]): DoctorCheck {
  return { id, label: id, status, detail: `${id} is ${status}` };
}

describe("the doctor verdict", () => {
  it("passes a report with nothing but passing checks", () => {
    expect(doctorVerdict([check("hyper-state", "pass"), check("memory", "pass")])).toBe("pass");
  });

  it("fails on any failing check, whatever else the report says", () => {
    expect(doctorVerdict([check("memory", "pass"), check("mcp", "fail")])).toBe("fail");
  });

  it("reports inconclusive when Hyper's own record of the project is degraded", () => {
    // The exact finding LC-97 reports: verbs ran here and recorded no session.
    expect(
      doctorVerdict([check("hyper-state", "warn"), check("mcp", "pass")]),
      "'the work was not coordinated by Hyper' is not compatible with PASS"
    ).toBe("inconclusive");
  });

  it("still passes when only an optional capability is missing", () => {
    // Memory (D-118), intel and a Kit-less project are supported
    // configurations. Warning about them narrows what the project can do; it
    // does not make the report untrue, and it must not cost the verdict.
    expect(
      doctorVerdict([
        check("memory", "warn"),
        check("intel-mcp", "warn"),
        check("kit-artifacts", "warn"),
        check("git-hook", "warn"),
        check("selected-host", "warn"),
        check("kit-next-gate", "warn")
      ])
    ).toBe("pass");
  });

  it("lets a failure outrank a verdict-bearing warning", () => {
    expect(doctorVerdict([check("hyper-state", "warn"), check("kit-policy", "fail")])).toBe("fail");
  });

  it("treats a check nobody classified as verdict-bearing", () => {
    // Fail closed, the same way the strict contracts do. A check added later
    // without a decision costs the verdict rather than passing silently — and
    // that includes the bridge warnings, whose ids are generated from whatever
    // Kit said.
    expect(isVerdictBearing("some-check-added-next-quarter")).toBe(true);
    expect(isVerdictBearing("kit-detect-warning-1")).toBe(true);
    expect(doctorVerdict([check("kit-detect-warning-1", "warn")])).toBe("inconclusive");
  });

  it("classifies the memory warning this repository added last as advisory", () => {
    // LC-93 made doctor WARN when a project holds a visp-memory store the
    // bridge is switched off from. That warning is about a capability that is
    // paid for and unreachable, not about whether this report is sound.
    expect(isVerdictBearing("memory")).toBe(false);
  });
});
