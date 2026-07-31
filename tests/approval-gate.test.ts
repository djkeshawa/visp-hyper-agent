import { describe, expect, it } from "vitest";
import {
  UNDECLARED_APPROVAL_CLASS,
  approvalDecisionFor
} from "../src/governance/approval-gate.js";

/**
 * P8-05, Hyper side. Kit declares the approval class; this enforces it.
 * The tests pin the three ways enforcement could quietly become permissive:
 * an absent declaration, an unknown value, and a confidence signal sneaking in.
 */
describe("P8-05 approval gate", () => {
  it("obeys approval_required and refuses autonomy", () => {
    const decision = approvalDecisionFor({ approvalClass: "approval_required", reversibility: "irreversible" });
    expect(decision.mayProceedAutonomously).toBe(false);
    expect(decision.requiresCheckpoint).toBe(true);
    expect(decision.reason).toMatch(/cannot be undone/u);
  });

  it("explains an external blast radius in its own terms", () => {
    const decision = approvalDecisionFor({ approvalClass: "approval_required", blastRadius: "external" });
    expect(decision.reason).toMatch(/outside this repository/u);
  });

  it("lets checkpointed work proceed, but only with a checkpoint", () => {
    const decision = approvalDecisionFor({ approvalClass: "checkpointed" });
    expect(decision.mayProceedAutonomously).toBe(true);
    expect(decision.requiresCheckpoint).toBe(true);
  });

  it("allows autonomous work with no checkpoint", () => {
    const decision = approvalDecisionFor({ approvalClass: "autonomous" });
    expect(decision.mayProceedAutonomously).toBe(true);
    expect(decision.requiresCheckpoint).toBe(false);
  });

  it("an undeclared task is checkpointed, never autonomous", () => {
    // A task graph written before P8-05 must not gain freedom by omitting a
    // field. Absent is not consent.
    const decision = approvalDecisionFor({});
    expect(decision.approvalClass).toBe(UNDECLARED_APPROVAL_CLASS);
    expect(UNDECLARED_APPROVAL_CLASS).toBe("checkpointed");
    expect(decision.mayProceedAutonomously).toBe(false);
    expect(decision.declared).toBe(false);
    expect(decision.reason).toMatch(/not consent/u);
  });

  it("fails closed on a class this build does not recognise", () => {
    // More likely a newer Kit declaring something stricter than a typo meaning
    // "anything goes".
    const decision = approvalDecisionFor({ approvalClass: "quarantined" as never });
    expect(decision.approvalClass).toBe("approval_required");
    expect(decision.mayProceedAutonomously).toBe(false);
    expect(decision.reason).toMatch(/failing closed/u);
  });

  it("never reads a confidence signal", () => {
    // Extra fields that look like confidence must not change the answer. Being
    // sure is not the same as being allowed.
    const base = approvalDecisionFor({ approvalClass: "approval_required" });
    const withNoise = approvalDecisionFor({
      approvalClass: "approval_required",
      // deliberately shaped like a calibration payload
      ...({ confidence: 1, passRate: 1, calibrated: true } as unknown as object)
    } as never);
    expect(withNoise).toEqual(base);
  });
});
