import { describe, expect, it } from "vitest";
import {
  applyIndependenceVerdict,
  judgeChallengerIndependence
} from "../../../src/quality/challenger-independence.js";

/**
 * P8-06. The unit's own gate held back the challenger capability — no paired
 * evaluation has run, so backlog rule 16 applies. What is built is the
 * constraint: a result labelled `independent_challenger` must actually come
 * from a different model, or it cannot pass.
 */
const OPENAI = { modelId: "gpt-x", modelVersion: "2026-07" };
const OTHER = { modelId: "claude-y", modelVersion: "2026-07" };

describe("P8-06 challenger independence", () => {
  it("a challenger sharing the implementer's model records inconclusive, never passed", () => {
    // The unit's stated validation. Same model reviewing its own work shares its
    // blind spots, so agreement is not evidence.
    const verdict = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: OPENAI,
      challenger: { ...OPENAI }
    });
    expect(verdict.independent).toBe(false);
    expect(applyIndependenceVerdict("passed", verdict)).toBe("inconclusive");
    expect(verdict.reason).toMatch(/agreement, not evidence/u);
  });

  it("accepts a genuinely different model", () => {
    const verdict = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: OPENAI,
      challenger: OTHER
    });
    expect(verdict.independent).toBe(true);
    expect(applyIndependenceVerdict("passed", verdict)).toBe("passed");
  });

  it("treats a tier name as no identity at all", () => {
    // Hyper's tiers are cost tiers. "scout" and "implementer" can resolve to the
    // same model, so accepting them as distinct would certify independence that
    // does not exist.
    for (const placeholder of ["scout", "implementer", "coordinator", "unknown", ""]) {
      const verdict = judgeChallengerIndependence({
        claim: "independent_challenger",
        implementer: OPENAI,
        challenger: { modelId: placeholder, modelVersion: null }
      });
      expect(verdict.independent, placeholder).toBe(false);
      expect(applyIndependenceVerdict("passed", verdict)).toBe("inconclusive");
    }
  });

  it("a missing identity on either side fails closed", () => {
    expect(
      judgeChallengerIndependence({ claim: "independent_challenger", challenger: OTHER }).independent
    ).toBe(false);
    expect(
      judgeChallengerIndependence({ claim: "independent_challenger", implementer: OPENAI }).independent
    ).toBe(false);
  });

  it("same model id at a different version is still the same model", () => {
    const verdict = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: { modelId: "gpt-x", modelVersion: "2026-07" },
      challenger: { modelId: "gpt-x", modelVersion: "2026-08" }
    });
    // Different version is a different identity, so this one is permitted —
    // pinned so the rule is a deliberate choice rather than an accident.
    expect(verdict.independent).toBe(true);
  });

  it("leaves the other independence classes alone", () => {
    for (const claim of ["pre_existing", "pre_approved", "implementer_authored", "human_attestation"] as const) {
      const verdict = judgeChallengerIndependence({ claim, implementer: OPENAI, challenger: OPENAI });
      expect(verdict.forcedOutcome, claim).toBeNull();
      expect(applyIndependenceVerdict("passed", verdict)).toBe("passed");
    }
  });

  it("can only ever downgrade — a failure never becomes a pass", () => {
    // This is why adding the constraint does not expand the challenger
    // capability the P8-06 gate holds back.
    const blocking = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: OPENAI,
      challenger: OPENAI
    });
    expect(applyIndependenceVerdict("failed", blocking)).toBe("failed");
    expect(applyIndependenceVerdict("inconclusive", blocking)).toBe("inconclusive");
    const permitting = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: OPENAI,
      challenger: OTHER
    });
    expect(applyIndependenceVerdict("failed", permitting)).toBe("failed");
  });

  it("comparison ignores case and surrounding whitespace", () => {
    const verdict = judgeChallengerIndependence({
      claim: "independent_challenger",
      implementer: { modelId: "GPT-X", modelVersion: "2026-07" },
      challenger: { modelId: "  gpt-x  ", modelVersion: "2026-07" }
    });
    expect(verdict.independent).toBe(false);
  });
});
