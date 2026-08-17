// LC-135 — Hyper keeps reading a Kit report after Kit adds a field to it.
//
// Reported as a Hyper defect: Kit PR #9 added `taskStatusUpdate` to the
// reconcile report and `scopeBasis` to the review report, and reads of both
// started failing with `Unrecognized key(s) in object: …` on merged develop.
//
// MEASURED, and the rejection is not Hyper's. `Unrecognized key(s) in object`
// is zod's `.strict()` message, and none of Hyper's Kit mirrors is strict —
// `kitReviewSummarySchema` and `kitReconcileSummarySchema` are plain
// `z.object`, which strips unknown keys. Both sentences are Kit's own, produced
// by `readOptional` in visp-kit's `src/orchestrator/project-state.ts` when Kit
// reads its own artifacts, and Hyper only relays them through `visp status`'s
// warnings. Parsing an object carrying either key through each Kit's exported
// `reconcileReportSchema` / `reviewReportSchema` locates it exactly: published
// visp-kit 0.5.0 rejects both, visp-kit develop (0.6.0) accepts both. The
// artifacts were written by the newer Kit and read by the older one.
//
// So most of what follows pins what Hyper can promise Kit — additive fields on
// the report envelopes cost nothing here — and those assertions PASSED BEFORE
// THE TICKET WAS FILED. They are a guard, not a fix: someone tightening these
// mirrors to `.strict()` later would break every Kit release that adds a field,
// which is the compatibility rule AGENTS.md requires of the pair.
//
// ONE assertion below did fail beforehand, and it is a different defect in the
// same area: `taskStatusUpdate` was tolerated by being STRIPPED, so the field
// that says whether the task actually closed never reached the reader. See
// `tests/unit/cli/commands/checkpoint/task-status-line.test.ts` for what that
// cost. Tolerating a field and mirroring it are not the same promise.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KitCommandBridge } from "../../../src/kit/kit-command-bridge.js";
import { createVispShim } from "../../helpers/visp-shim.js";

const originalPath = process.env.PATH;
let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "visp-report-mirrors-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
});

/** The fields Kit PR #9 shipped, and the four PR #10 adds to the same reports. */
const REVIEW_ADDITIONS = {
  scopeBasis: { mode: "task", paths: ["src/feature.ts"] },
  statusBasis: { source: "checklist" },
  coverage: { statements: 91.2 },
  reviewedExpectedFiles: ["tests/feature.test.ts"]
};
const RECONCILE_ADDITIONS = {
  taskStatusUpdate: {
    requested: true,
    performed: false,
    taskId: "T001",
    previousStatus: "pending",
    newStatus: null,
    skippedReason: "T001 depends on T000, which is not done"
  }
};

async function bridgeAgainst(spec: Record<string, { stdout: object }>): Promise<KitCommandBridge> {
  const shim = await createVispShim(spec);
  return new KitCommandBridge({ projectPath, binary: shim.binary });
}

describe("Hyper's Kit report mirrors", () => {
  it("reads a review summary carrying fields this Hyper has never heard of", async () => {
    const bridge = await bridgeAgainst({
      review: { stdout: { success: true, findings: [], ...REVIEW_ADDITIONS } }
    });

    const review = await bridge.checkReview("T001");

    expect(review, "an additive Kit field must never cost Hyper the whole read").not.toBeNull();
    expect(review?.success).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });

  it("reads a reconcile summary carrying fields this Hyper has never heard of", async () => {
    const bridge = await bridgeAgainst({
      reconcile: { stdout: { success: true, result: "passed", somethingKitAddsNext: { a: 1 } } }
    });

    const reconcile = await bridge.reconcile("T001");

    expect(reconcile).not.toBeNull();
    expect(reconcile?.result, "the known fields still arrive intact").toBe("passed");
    expect(bridge.warnings).toEqual([]);
  });

  it("keeps `taskStatusUpdate` instead of stripping it on the floor", async () => {
    // The one real Hyper defect in this area, and the only assertion here that
    // failed before the change: tolerating an unknown field is not the same as
    // mirroring a field that decides what the reader is told. Stripped, a
    // reconcile that passed while refusing to close the task was reported as a
    // clean close — the defect `result` was mirrored to fix, one layer down.
    const bridge = await bridgeAgainst({
      reconcile: { stdout: { success: true, result: "passed", ...RECONCILE_ADDITIONS } }
    });

    const reconcile = await bridge.reconcile("T001");

    expect(reconcile?.taskStatusUpdate).toMatchObject({
      requested: true,
      performed: false,
      skippedReason: "T001 depends on T000, which is not done"
    });
  });

  it("reads a verify summary carrying an unknown field", async () => {
    // `codeEvidence` is the same class of addition, on the third report.
    const bridge = await bridgeAgainst({
      verify: { stdout: { success: true, errors: [], codeEvidence: { files: 3 } } }
    });

    const verify = await bridge.checkVerify("T001");

    expect(verify?.success).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });

  it("still fails closed when a field Hyper DOES consume has the wrong type", async () => {
    // Tolerating unknown keys is not tolerating a broken contract. Without
    // this, the three assertions above would be satisfied by a mirror that
    // accepted anything at all, and the strictness that matters — the fields
    // Hyper reads a verdict out of — would be untested.
    const bridge = await bridgeAgainst({
      review: { stdout: { success: "yes", ...REVIEW_ADDITIONS } }
    });

    const review = await bridge.checkReview("T001");

    expect(review, "`success` is the field a checkpoint verdict is read from").toBeNull();
    expect(bridge.warnings.join(" ")).toContain("schema");
  });
});

describe("the strict surfaces stay strict", () => {
  it("does not accept an unknown key on the negotiated canonical action", async () => {
    // The action is where permission, evidence sufficiency, completion and PR
    // readiness are decided, so an unknown key there must still fail closed —
    // widening the report mirrors says nothing about this surface.
    const { workflowActionV3StrictSchema } = await import(
      "../../../src/kit/workflow-action-protocol.js"
    );
    const parsed = workflowActionV3StrictSchema.safeParse({ somethingNew: true });

    expect(parsed.success).toBe(false);
  });
});
