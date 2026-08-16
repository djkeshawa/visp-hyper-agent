// Non-negotiable rule 4, the Kit-less half: a level Hyper mints for itself is
// `advisory` or `local_checked` — never `kit_strict`.
//
// `aggregateKitCheckpointEvidence` summarises Kit's *stage output*, which is
// not a Kit action and grants no strict assurance. That distinction held only
// by construction: the literal `"advisory"` appears twice in
// `src/quality/kit-checkpoint-evidence.ts` and nothing went red if it changed.
//
// The assertion reads the `assurance_level:` line of the rendered checkpoint
// result block, because that string is what a host parses. The Kit-supplied
// half is pinned in `tests/unit/kit/workflow-action-assurance-level.test.ts`;
// the `local_checked` path in
// `tests/integration/cli/checkpoint-assurance-level.test.ts`.

import { describe, expect, it } from "vitest";

import {
  aggregateKitCheckpointEvidence,
  renderKitCheckpointEvidence,
  unavailableKitCheckpointEvidence
} from "../../../src/quality/kit-checkpoint-evidence.js";
import { checkpointBlockField } from "../../helpers/checkpoint-block.js";

const passingKitStage = { success: true, errors: [], warnings: [], findings: [] };

describe("the assurance level Hyper mints from Kit checkpoint output", () => {
  it("is advisory when the configured Kit could not be reached at all", () => {
    const block = renderKitCheckpointEvidence({
      taskId: "T001",
      evidence: unavailableKitCheckpointEvidence({
        reasonCode: "strict_session_binding_unavailable",
        reason: "No strict session binding is available."
      }),
      contextFreshness: "fresh"
    });

    expect(checkpointBlockField(block, "assurance_level")).toBe("advisory");
    expect(block).not.toContain("kit_strict");
  });

  it("is advisory even when every Kit stage passed", () => {
    // The strongest case for the defect: verify, review and reconcile all
    // passed, so the aggregate looks exactly like a strict result. It is still
    // Hyper's own summary of Kit output, not a Kit verdict, and must say so.
    const block = renderKitCheckpointEvidence({
      taskId: "T001",
      evidence: aggregateKitCheckpointEvidence({
        verify: passingKitStage,
        review: passingKitStage,
        reconcile: passingKitStage
      }),
      contextFreshness: "fresh"
    });

    expect(block).toContain("verdict: PASSED");
    expect(checkpointBlockField(block, "assurance_level")).toBe("advisory");
    expect(block).not.toContain("kit_strict");
  });
});
