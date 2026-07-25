import { describe, expect, it } from "vitest";
import {
  createWorkflowActionV3Id,
  normalizeWorkflowAction,
  type NormalizedWorkflowAction
} from "../src/kit/workflow-action-adapter.js";
import {
  TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES,
  workflowActionV2StrictSchema,
  workflowActionV32StrictSchema,
  workflowActionV3StrictSchema,
  type WorkflowActionProtocolSelection
} from "../src/kit/workflow-action-protocol.js";
import {
  HYPER_ACTION_FRAME_BEGIN,
  HYPER_ACTION_FRAME_END,
  classifyHyperActionEnvelope,
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../src/kit/workflow-action-renderer.js";
import { workflowActionV32Fixture } from "./helpers/canonical-action-fixture.js";

const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });
const notApplicable = (reasonCode = "stage_does_not_require_value") => ({
  state: "not_applicable" as const,
  reasonCode
});

function selection(protocolVersion: "2.0" | "3.0" | "3.2"): WorkflowActionProtocolSelection {
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

function normalizedV2(
  overrides: Record<string, unknown> = {}
): NormalizedWorkflowAction {
  const wire = workflowActionV2StrictSchema.parse({
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T001",
    goal: "Render the accepted action.",
    requiredReads: [
      { path: ".visp/policy.json", role: "policy", sha256: "a".repeat(64) }
    ],
    writablePaths: ["src\\feature with space.ts"],
    forbiddenPaths: ["package.json"],
    acceptanceOracles: [
      { id: "AC001", expectedBehavior: "The envelope is exact.", validation: "unit" }
    ],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: 'visp verify --task "T 001" && echo untouched',
    ...overrides
  });
  const result = normalizeWorkflowAction(wire, selection("2.0"));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function normalizedV3(): NormalizedWorkflowAction {
  const draft = {
    protocolVersion: "3.0" as const,
    canonicalVersion: "1.0" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    phase: "implement" as const,
    feature: { id: "006", slug: "canonical-rendering" },
    task: {
      id: "T001",
      title: "Render canonical actions",
      status: "ready" as const,
      dependsOn: [],
      parallelizable: false
    },
    taskClass: unavailable(),
    risk: { level: available("high" as const), factors: unavailable() },
    assurance: {
      level: "kit_strict" as const,
      profile: unavailable(),
      workflowStrictness: available("strict" as const)
    },
    goal: "Render the accepted action.",
    baseCommit: unavailable("not_captured"),
    requiredReads: [
      {
        id: "READ001",
        role: "policy" as const,
        path: ".visp/policy.json",
        contentHash: `sha256:${"a".repeat(64)}`,
        freshness: "content_hash" as const
      }
    ],
    scope: {
      writablePaths: ["src/feature with space.ts"],
      expectedPaths: notApplicable(),
      forbiddenPaths: ["package.json"],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [
      {
        id: "AC001",
        claimId: "REQ001",
        statement: "The envelope is exact.",
        testable: true,
        validationMethod: "unit" as const
      }
    ],
    validationCommands: ["pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid" as const), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready" as const,
    nextCommand: 'visp verify --task "T 001" && echo untouched'
  };
  const wire = workflowActionV3StrictSchema.parse({
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  });
  const result = normalizeWorkflowAction(wire, selection("3.0"));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

function normalizedV32(): NormalizedWorkflowAction {
  const wire = workflowActionV32StrictSchema.parse(workflowActionV32Fixture());
  const result = normalizeWorkflowAction(wire, selection("3.2"));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("Hyper canonical action renderer", () => {
  it.each([
    ["v2", normalizedV2()],
    ["v3", normalizedV3()],
    ["v3.2", normalizedV32()]
  ])("projects %s without wire and preserves every normalized public field", (_name, action) => {
    const envelope = toHyperActionEnvelope(action);
    const { wire: _wire, ...publicAction } = action;

    expect(Object.keys(envelope)).toEqual(["frameVersion", "authority", "action"]);
    expect(envelope).toEqual({
      frameVersion: "1.0",
      authority: "kit",
      action: publicAction
    });
    expect("wire" in envelope.action).toBe(false);
    expect(envelope.action.source).toEqual(action.source);
    expect(envelope.action.nextCommand).toBe(action.nextCommand);
    if (_name === "v3") {
      expect(envelope.action.scope.expectedPaths).toEqual({
        state: "not_applicable",
        reasonCode: "stage_does_not_require_value"
      });
    }
    if (_name === "v3.2") {
      expect(envelope.action.assuranceSummary).toEqual(action.assuranceSummary);
      expect(envelope.action.nextCommand).toBe(action.nextCommand);
    }
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.action)).toBe(true);
    expect(Object.isFrozen(envelope.action.scope)).toBe(true);

    expect(renderHyperActionFrame(envelope)).toBe(
      [HYPER_ACTION_FRAME_BEGIN, JSON.stringify(envelope), HYPER_ACTION_FRAME_END].join(
        "\n"
      )
    );
    expect(renderHyperActionFrame(toHyperActionEnvelope(action))).toBe(
      renderHyperActionFrame(envelope)
    );
  });

  it("preserves task absence, honest v2 availability, normalized spaced paths, and opaque commands", () => {
    const action = normalizedV2({ taskId: null });
    const envelope = toHyperActionEnvelope(action);

    expect(envelope.action.task).toBeNull();
    expect(envelope.action.phase).toEqual({
      state: "unavailable",
      reasonCode: "not_in_protocol"
    });
    expect(envelope.action.scope.writablePaths).toEqual(["src/feature with space.ts"]);
    expect(envelope.action.nextCommand).toBe(
      'visp verify --task "T 001" && echo untouched'
    );
  });

  it("minimally classifies valid envelopes and rejects tampering without treating unrelated JSON as authority", () => {
    const envelope = toHyperActionEnvelope(normalizedV3());

    expect(classifyHyperActionEnvelope(envelope)).toEqual({
      kind: "valid",
      verdict: "ready"
    });
    expect(
      classifyHyperActionEnvelope({
        ...envelope,
        action: { ...envelope.action, wire: {} }
      })
    ).toEqual({ kind: "invalid" });
    expect(classifyHyperActionEnvelope({ ...envelope, frameVersion: "2.0" })).toEqual({
      kind: "invalid"
    });
    expect(classifyHyperActionEnvelope({ message: "transport failed" })).toEqual({
      kind: "unrelated"
    });
    expect(
      classifyHyperActionEnvelope({ authority: "proxy", message: "transport failed" })
    ).toEqual({ kind: "unrelated" });
  });
});
