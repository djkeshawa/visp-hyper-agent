import { describe, expect, it } from "vitest";
import {
  aggregateKitCheckpointEvidence,
  renderKitCheckpointEvidence,
  unavailableKitCheckpointEvidence
} from "../src/quality/kit-checkpoint-evidence.js";

const passed = { success: true } as const;

describe("Kit checkpoint evidence", () => {
  it("keeps three successful summaries advisory and inconclusive without transition authority", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: passed,
      review: passed,
      reconcile: passed
    });

    expect(evidence).toEqual({
      verifyVerdict: "passed",
      reviewVerdict: "passed",
      reconcileVerdict: "passed",
      verdict: "inconclusive",
      assuranceLevel: "advisory",
      evidenceSource: "kit",
      reasonCode: "kit_post_checkpoint_transition_unavailable",
      reason:
        "Kit checkpoint summaries passed, but the current contract exposes no authoritative post-checkpoint transition.",
      findings: []
    });
  });

  it("preserves warnings and findings from successful Kit summaries", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: true, warnings: ["coverage report is partial"] },
      review: { success: true, findings: [{ message: "human review remains required" }] },
      reconcile: passed
    });

    expect(evidence.verdict).toBe("inconclusive");
    expect(evidence.reasonCode).toBe("kit_post_checkpoint_transition_unavailable");
    expect(evidence.findings).toEqual([
      "verify warning: coverage report is partial",
      "review finding: human review remains required"
    ]);
  });

  it("treats success=true with errors as incoherent instead of passing", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: true, errors: ["verification process was interrupted"] },
      review: passed
    });

    expect(evidence).toMatchObject({
      verifyVerdict: "inconclusive",
      reconcileVerdict: "not_run",
      verdict: "inconclusive",
      assuranceLevel: "advisory",
      reasonCode: "kit_verify_incoherent"
    });
    expect(evidence.findings).toContain("verify reported success=true with errors");
    expect(evidence.findings).toContain("verify error: verification process was interrupted");
  });

  it.each(["verify", "review", "reconcile"] as const)(
    "preserves a failed %s fact without strict assurance",
    (stage) => {
      const evidence = aggregateKitCheckpointEvidence({
        verify:
          stage === "verify"
            ? { success: false, errors: ["verification failed"] }
            : passed,
        review:
          stage === "review" ? { success: false, findings: [{ message: "review failed" }] } : passed,
        reconcile:
          stage === "reconcile"
            ? { success: false, warnings: ["traceability drift"] }
            : stage === "verify" || stage === "review"
              ? undefined
              : passed
      });

      expect(evidence.verdict).toBe("failed");
      expect(evidence.assuranceLevel).toBe("advisory");
      expect(evidence.reasonCode).toBe(`kit_${stage}_failed`);
      expect(evidence.findings.join("\n")).toContain(stage);
    }
  );

  it.each(["verify", "review", "reconcile"] as const)(
    "preserves unavailable %s evidence as inconclusive",
    (stage) => {
      const evidence = aggregateKitCheckpointEvidence({
        verify: stage === "verify" ? null : passed,
        review: stage === "review" ? null : passed,
        reconcile: stage === "reconcile" ? null : passed
      });

      expect(evidence.verdict).toBe("inconclusive");
      expect(evidence.assuranceLevel).toBe("advisory");
      expect(evidence.reasonCode).toBe(`kit_${stage}_unavailable`);
      expect(evidence.findings).toContain(`${stage} evidence was unavailable or unparseable`);
    }
  );

  it("records that reconcile did not run after an earlier inconclusive stage", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: null,
      review: passed
    });

    expect(evidence.verifyVerdict).toBe("inconclusive");
    expect(evidence.reconcileVerdict).toBe("not_run");
    expect(evidence.reasonCode).toBe("kit_verify_unavailable");
  });

  it("fails closed when the pinned context is stale", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: true, warnings: ["coverage report is partial"] },
      review: passed,
      reconcile: passed,
      blockingFindings: ["context artifact changed since handoff"]
    });

    expect(evidence).toMatchObject({
      verdict: "failed",
      assuranceLevel: "advisory",
      reasonCode: "context_freshness_failed"
    });
    expect(evidence.findings).toEqual([
      "verify warning: coverage report is partial",
      "context artifact changed since handoff"
    ]);
  });

  it("represents configured-unhealthy authority without running stages", () => {
    expect(
      unavailableKitCheckpointEvidence({
        reasonCode: "status_failed",
        reason: "visp status reported success=false."
      })
    ).toEqual({
      verifyVerdict: "not_run",
      reviewVerdict: "not_run",
      reconcileVerdict: "not_run",
      verdict: "inconclusive",
      assuranceLevel: "advisory",
      evidenceSource: "kit",
      reasonCode: "status_failed",
      reason: "visp status reported success=false.",
      findings: ["visp status reported success=false."]
    });
  });

  it("renders a deterministic frame without strict progression or remediation", () => {
    const output = renderKitCheckpointEvidence({
      taskId: "T001",
      evidence: aggregateKitCheckpointEvidence({
        verify: passed,
        review: passed,
        reconcile: passed
      }),
      contextFreshness: "current",
      warnings: ["context warning\ncontinued"]
    });

    expect(output).toContain("verify: PASSED");
    expect(output).toContain("reconcile: PASSED");
    expect(output).toContain("assurance_level: advisory");
    expect(output).toContain("reason_code: kit_post_checkpoint_transition_unavailable");
    expect(output).toContain(" - context warning continued");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).not.toContain("kit_strict");
    expect(output).not.toContain("instruction:");
    expect(output).not.toContain("next_task:");
    expect(output).not.toContain("pipeline_complete:");
  });
});
