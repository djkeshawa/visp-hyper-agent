// Non-negotiable rule 4, the Kit-supplied half: `kit_strict` is legitimate
// exactly when the Kit action declared it.
//
// `kit_strict` enters Hyper through one door — the WorkflowAction wire schema —
// and this file pins that the level a caller reads back is the one that came
// through that door, not a constant Hyper chose. The other half (every level
// Hyper mints with no Kit action) is pinned in
// `tests/unit/quality/kit-checkpoint-assurance-level.test.ts` and
// `tests/integration/cli/checkpoint-assurance-level.test.ts`.
//
// The assertion reads the JSON inside the rendered `VISP_HYPER_ACTION_V1`
// frame, which is what a host actually consumes. Asserting the adapter's
// internal field instead would pass even if the frame stopped carrying it.

import { describe, expect, it } from "vitest";

import {
  normalizeWorkflowAction,
  type NormalizedWorkflowAction
} from "../../../src/kit/workflow-action-adapter.js";
import {
  TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES,
  workflowActionV2StrictSchema,
  workflowActionV34StrictSchema,
  type WorkflowActionProtocolSelection
} from "../../../src/kit/workflow-action-protocol.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../../src/kit/workflow-action-renderer.js";
import {
  workflowActionV2Fixture,
  workflowActionV34Fixture
} from "../../helpers/canonical-action-fixture.js";

function selection(protocolVersion: "2.0" | "3.4"): WorkflowActionProtocolSelection {
  const localSchemaHash = TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES[protocolVersion];
  return {
    protocolVersion,
    mode: "advertised",
    localSchemaHash,
    schemaHashVerification: {
      state: "advertised_verified",
      advertisedHash: localSchemaHash
    }
  } as WorkflowActionProtocolSelection;
}

function normalized(
  action: Parameters<typeof normalizeWorkflowAction>[0]
): NormalizedWorkflowAction {
  const result = normalizeWorkflowAction(
    action,
    selection(action.protocolVersion === "2.0" ? "2.0" : "3.4")
  );
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

/** The assurance level a host reads out of the rendered action frame. */
function emittedFrameLevel(action: NormalizedWorkflowAction): unknown {
  const frame = renderHyperActionFrame(toHyperActionEnvelope(action));
  const payload = JSON.parse(frame.split("\n")[1]!) as {
    action: { assurance: { level: unknown } };
  };
  return payload.action.assurance.level;
}

describe("the assurance level a Kit-supplied action is emitted with", () => {
  // Both arms matter. Only the `kit_strict` arm shows the level survives the
  // adapter; only the `advisory` arm shows it was read from the wire rather
  // than pinned to a constant that happens to read `kit_strict`.
  it.each(["kit_strict", "advisory"] as const)(
    "is the level the WorkflowAction 2.0 payload declared (%s)",
    (declared) => {
      const wire = workflowActionV2StrictSchema.parse(
        workflowActionV2Fixture({ assuranceLevel: declared })
      );

      expect(emittedFrameLevel(normalized(wire))).toBe(declared);
    }
  );

  it.each(["kit_strict", "advisory"] as const)(
    "is the level the WorkflowAction 3.4 payload declared (%s)",
    (declared) => {
      const wire = workflowActionV34StrictSchema.parse(
        workflowActionV34Fixture({
          assurance: {
            level: declared,
            profile: { state: "unavailable", reasonCode: "not_in_source_artifact" },
            workflowStrictness: { state: "available", value: "strict" }
          }
        })
      );

      expect(emittedFrameLevel(normalized(wire))).toBe(declared);
    }
  );
});
