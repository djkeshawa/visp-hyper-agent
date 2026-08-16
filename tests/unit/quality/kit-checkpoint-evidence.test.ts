import { describe, expect, it } from "vitest";
import {
  aggregateKitCheckpointEvidence,
  renderKitCheckpointEvidence,
  unavailableKitCheckpointEvidence
} from "../../../src/quality/kit-checkpoint-evidence.js";

const passed = { success: true } as const;

function expectNoActionOrTransitionSemantics(output: string): void {
  for (const forbidden of [
    "kit_strict",
    "BEGIN_VISP_HYPER_ACTION_V1",
    "BEGIN_VISP_TASK_ACTION",
    "action:",
    "transition:",
    "instruction:",
    "next_command:",
    "next_task:",
    "pipeline_complete:"
  ]) {
    expect(output).not.toContain(forbidden);
  }
}

describe("Kit checkpoint evidence", () => {
  it("returns advisory passed evidence for three coherent successful summaries", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: passed,
      review: passed,
      reconcile: passed
    });

    expect(evidence).toEqual({
      verifyVerdict: "passed",
      reviewVerdict: "passed",
      reconcileVerdict: "passed",
      verdict: "passed",
      assuranceLevel: "advisory",
      evidenceSource: "kit",
      reasonCode: "kit_checkpoint_passed",
      reason: "Kit verify, review, and reconcile reported passing checkpoint evidence.",
      findings: []
    });
  });

  it("preserves warnings and findings from successful Kit summaries", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: true, warnings: ["coverage report is partial"] },
      review: { success: true, findings: [{ message: "human review remains required" }] },
      reconcile: passed
    });

    expect(evidence.verdict).toBe("passed");
    expect(evidence.reasonCode).toBe("kit_checkpoint_passed");
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

  it("prioritizes blocking freshness over failed, incoherent, and unavailable stages", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: false, errors: ["verification failed"] },
      review: { success: true, errors: ["review is contradictory"] },
      reconcile: null,
      blockingFindings: ["context artifact changed since handoff"]
    });

    expect(evidence).toEqual({
      verifyVerdict: "failed",
      reviewVerdict: "inconclusive",
      reconcileVerdict: "inconclusive",
      verdict: "failed",
      assuranceLevel: "advisory",
      evidenceSource: "kit",
      reasonCode: "context_freshness_failed",
      reason: "The adopted Kit context is no longer current.",
      findings: [
        "verify failed",
        "verify error: verification failed",
        "review reported success=true with errors",
        "review error: review is contradictory",
        "reconcile evidence was unavailable or unparseable",
        "context artifact changed since handoff"
      ]
    });
  });

  it("prioritizes failure over an earlier incoherent stage and a later not-run stage", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: { success: true, errors: ["verify is contradictory"] },
      review: { success: false, errors: ["review failed"] }
    });

    expect(evidence).toMatchObject({
      verifyVerdict: "inconclusive",
      reviewVerdict: "failed",
      reconcileVerdict: "not_run",
      verdict: "failed",
      reasonCode: "kit_review_failed"
    });
  });

  it("prioritizes failure over an earlier unavailable stage", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: null,
      review: { success: false, errors: ["review failed"] },
      reconcile: passed
    });

    expect(evidence).toMatchObject({
      verifyVerdict: "inconclusive",
      reviewVerdict: "failed",
      reconcileVerdict: "passed",
      verdict: "failed",
      reasonCode: "kit_review_failed"
    });
  });

  it("prioritizes incoherence over earlier unavailable and later not-run stages", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: null,
      review: { success: true, errors: ["review is contradictory"] }
    });

    expect(evidence).toMatchObject({
      verifyVerdict: "inconclusive",
      reviewVerdict: "inconclusive",
      reconcileVerdict: "not_run",
      verdict: "inconclusive",
      reasonCode: "kit_review_incoherent"
    });
  });

  it("records that reconcile did not run after an earlier inconclusive stage", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: null,
      review: passed
    });

    expect(evidence.verifyVerdict).toBe("inconclusive");
    expect(evidence.reconcileVerdict).toBe("not_run");
    expect(evidence.reasonCode).toBe("kit_verify_unavailable");
  });

  it("remains inconclusive when reconcile did not run", () => {
    const evidence = aggregateKitCheckpointEvidence({
      verify: passed,
      review: passed
    });

    expect(evidence).toMatchObject({
      verifyVerdict: "passed",
      reviewVerdict: "passed",
      reconcileVerdict: "not_run",
      verdict: "inconclusive",
      reasonCode: "kit_reconcile_not_run"
    });
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

  it("renders exact deterministic FAILED evidence with single-line fields", () => {
    const output = renderKitCheckpointEvidence({
      taskId: "T001\nshadow",
      evidence: aggregateKitCheckpointEvidence({
        verify: passed,
        review: { success: false, errors: ["unsafe review\nfinding"] }
      }),
      contextFreshness: "current\nverified",
      warnings: ["first warning\ncontinued", "first warning continued"]
    });

    expect(output).toBe(
      [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "task: T001 shadow",
        "verify: PASSED",
        "review: FAILED",
        "reconcile: NOT_RUN",
        "verdict: FAILED",
        "assurance_level: advisory",
        "evidence_source: kit",
        "context_freshness: current verified",
        "warnings:",
        " - first warning continued",
        "reason_code: kit_review_failed",
        "reason: Kit review reported failure.",
        "findings:",
        " - review failed",
        " - review error: unsafe review finding",
        "status: FAILED",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n")
    );
    expectNoActionOrTransitionSemantics(output);
  });

  it("renders exact deterministic INCONCLUSIVE evidence with single-line fields", () => {
    const output = renderKitCheckpointEvidence({
      taskId: "T002\r\nshadow",
      evidence: unavailableKitCheckpointEvidence({
        reasonCode: "authority_unavailable\ninjected",
        reason: "configured authority\nwas unavailable"
      }),
      contextFreshness: "unknown\nstate"
    });

    expect(output).toBe(
      [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "task: T002 shadow",
        "verify: NOT_RUN",
        "review: NOT_RUN",
        "reconcile: NOT_RUN",
        "verdict: INCONCLUSIVE",
        "assurance_level: advisory",
        "evidence_source: kit",
        "context_freshness: unknown state",
        "reason_code: authority_unavailable injected",
        "reason: configured authority was unavailable",
        "findings:",
        " - configured authority was unavailable",
        "status: INCONCLUSIVE",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n")
    );
    expectNoActionOrTransitionSemantics(output);
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

    expect(output).toBe(
      [
        "BEGIN_VISP_CHECKPOINT_RESULT",
        "task: T001",
        "verify: PASSED",
        "review: PASSED",
        "reconcile: PASSED",
        "verdict: PASSED",
        "assurance_level: advisory",
        "evidence_source: kit",
        "context_freshness: current",
        "warnings:",
        " - context warning continued",
        "reason_code: kit_checkpoint_passed",
        "reason: Kit verify, review, and reconcile reported passing checkpoint evidence.",
        "status: PASSED",
        "END_VISP_CHECKPOINT_RESULT"
      ].join("\n")
    );
    expect(output).not.toContain("kit_strict");
    expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).not.toContain("instruction:");
    expect(output).not.toContain("next_command:");
    expect(output).not.toContain("next_task:");
    expect(output).not.toContain("pipeline_complete:");
    expect(output).not.toContain("transition:");
  });
});
