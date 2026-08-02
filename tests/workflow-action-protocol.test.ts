import { describe, expect, it } from "vitest";
import {
  TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES,
  WORKFLOW_ACTION_PROTOCOL_PREFERENCE,
  parseSelectedWorkflowAction,
  selectWorkflowActionProtocol,
  workflowActionV2StrictSchema,
  workflowActionV31StrictSchema,
  workflowActionV32StrictSchema,
  workflowActionV3StrictSchema,
  type WorkflowActionProtocolSelection
} from "../src/kit/workflow-action-protocol.js";
import {
  createWorkflowActionV31Id,
  createWorkflowActionV32Id,
  createWorkflowActionV3Id,
  normalizeWorkflowAction
} from "../src/kit/workflow-action-adapter.js";
import { toHyperActionEnvelope } from "../src/kit/workflow-action-renderer.js";
import {
  workflowActionV31Fixture,
  workflowActionV32Fixture
} from "./helpers/canonical-action-fixture.js";

const V2_HASH =
  "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6";
const V3_HASH =
  "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7";
const V31_HASH =
  "sha256:41ffa28fcd4476ea1812ff307df67a7ab7edb5b2cf4d6c11955d34d4aad74d4d";
const V32_HASH =
  "sha256:77dcaba51ef8e1a78064680077f8bcc48c081d8025596c6cc8df9ea7873d68e9";
const V34_HASH =
  "sha256:bee85bf783a3557c99c9feb716e967997595dfa228380be71815da531f055ca5";
const V3_ACTION_ID =
  "sha256:f43debda81ad16a4cebb07c3f3ad149538a531b09dac991a284fb62219f50fce";

const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });

function integrationContract(protocols?: unknown): Record<string, unknown> {
  return {
    success: true,
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo",
    initialized: true,
    activeFeature: { id: "001", slug: "demo" },
    activeTask: { id: "T001", title: "Demo task", status: "ready" },
    ...(protocols === undefined ? {} : { protocols })
  };
}

function workflowActionAdvertisement(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    workflowAction: {
      supported: ["2.0", "3.0"],
      default: "2.0",
      schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH },
      ...overrides
    }
  };
}

function workflowActionV2(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T001",
    goal: "Implement the current task.",
    requiredReads: [
      { path: ".visp/policy.json", role: "policy", sha256: "a".repeat(64) }
    ],
    writablePaths: ["src\\feature.ts"],
    forbiddenPaths: ["package.json"],
    acceptanceOracles: [
      { id: "AC001", expectedBehavior: "The feature works.", validation: "unit" }
    ],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp implement",
    ...overrides
  };
}

function workflowActionV3(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "3.0",
    canonicalVersion: "1.0",
    actionId: V3_ACTION_ID,
    phase: "implement",
    feature: { id: "001", slug: "demo" },
    task: {
      id: "T001",
      title: "Demo task",
      status: "ready",
      dependsOn: [],
      parallelizable: false
    },
    taskClass: unavailable(),
    risk: { level: available("medium"), factors: unavailable() },
    assurance: {
      level: "kit_strict",
      profile: unavailable(),
      workflowStrictness: available("strict")
    },
    goal: "Implement the current task.",
    baseCommit: unavailable("not_captured"),
    requiredReads: [
      {
        id: "READ001",
        role: "policy",
        path: ".visp/policy.json",
        contentHash: `sha256:${"a".repeat(64)}`,
        freshness: "content_hash"
      }
    ],
    scope: {
      writablePaths: ["src/feature.ts"],
      expectedPaths: unavailable(),
      forbiddenPaths: ["package.json"],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [
      {
        id: "AC001",
        claimId: "REQ001",
        statement: "The feature works.",
        testable: true,
        validationMethod: "unit"
      }
    ],
    validationCommands: ["pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid"), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready",
    nextCommand: "visp implement",
    ...overrides
  };
}

function advertisedSelection(
  protocol: "2.0" | "3.0" | "3.1" | "3.2"
): WorkflowActionProtocolSelection {
  const advertisement =
    protocol === "3.2"
      ? workflowActionAdvertisement({
          supported: ["2.0", "3.0", "3.1", "3.2"],
          schemaHashes: {
            "2.0": V2_HASH,
            "3.0": V3_HASH,
            "3.1": V31_HASH,
            "3.2": V32_HASH
          }
        })
      : protocol === "3.1"
      ? workflowActionAdvertisement({
          supported: ["2.0", "3.0", "3.1"],
          schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH, "3.1": V31_HASH }
        })
      : workflowActionAdvertisement();
  const result = selectWorkflowActionProtocol(
    integrationContract(advertisement),
    protocol
  );
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("WorkflowAction protocol negotiation", () => {
  it("keeps immutable local preference and accepted schema-hash trust anchors", () => {
    expect(WORKFLOW_ACTION_PROTOCOL_PREFERENCE).toEqual(["3.4", "3.2", "3.1", "3.0", "2.0"]);
    expect(TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES).toEqual({
      "2.0": V2_HASH,
      "3.0": V3_HASH,
      "3.1": V31_HASH,
      "3.2": V32_HASH,
      "3.4": V34_HASH
    });
    expect(Object.isFrozen(WORKFLOW_ACTION_PROTOCOL_PREFERENCE)).toBe(true);
    expect(Object.isFrozen(TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)).toBe(true);
  });

  it("selects auto by local preference and records advertised hash verification", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({ supported: ["2.0", "4.0", "3.0"] , schemaHashes: {
          "2.0": V2_HASH,
          "3.0": V3_HASH,
          "4.0": `sha256:${"4".repeat(64)}`
        } })
      ),
      "auto"
    );

    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: "3.0",
        mode: "advertised",
        localSchemaHash: V3_HASH,
        schemaHashVerification: {
          state: "advertised_verified",
          advertisedHash: V3_HASH
        }
      }
    });
    if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("prefers advertised WorkflowAction 3.1 and verifies its exact trust anchor", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          supported: ["2.0", "3.0", "3.1"],
          schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH, "3.1": V31_HASH }
        })
      ),
      "auto"
    );

    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: "3.1",
        mode: "advertised",
        localSchemaHash: V31_HASH,
        schemaHashVerification: {
          state: "advertised_verified",
          advertisedHash: V31_HASH
        }
      }
    });
  });

  it("prefers advertised WorkflowAction 3.2 and verifies its exact trust anchor", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          supported: ["2.0", "3.0", "3.1", "3.2"],
          schemaHashes: {
            "2.0": V2_HASH,
            "3.0": V3_HASH,
            "3.1": V31_HASH,
            "3.2": V32_HASH
          }
        })
      ),
      "auto"
    );

    expect(result).toEqual({
      ok: true,
      value: {
        protocolVersion: "3.2",
        mode: "advertised",
        localSchemaHash: V32_HASH,
        schemaHashVerification: {
          state: "advertised_verified",
          advertisedHash: V32_HASH
        }
      }
    });
  });

  it("allows selector-less legacy v2 only for auto and explicit v2", () => {
    for (const preference of ["auto", "2.0"] as const) {
      expect(selectWorkflowActionProtocol(integrationContract(), preference)).toEqual({
        ok: true,
        value: {
          protocolVersion: "2.0",
          mode: "legacy_v2",
          localSchemaHash: V2_HASH,
          schemaHashVerification: { state: "legacy_unadvertised" }
        }
      });
    }
    expect(selectWorkflowActionProtocol(integrationContract(), "3.0")).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_no_mutual_protocol"
    });
    expect(selectWorkflowActionProtocol(integrationContract(), "3.1")).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_no_mutual_protocol"
    });
    expect(selectWorkflowActionProtocol(integrationContract(), "3.2")).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_no_mutual_protocol"
    });
  });

  it("selects advertised v2 when it is the only mutual protocol", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          supported: ["2.0"],
          default: "2.0",
          schemaHashes: { "2.0": V2_HASH }
        })
      ),
      "auto"
    );
    expect(result).toMatchObject({
      ok: true,
      value: { protocolVersion: "2.0", mode: "advertised" }
    });
  });

  it("never downgrades an explicit advertised preference", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          supported: ["2.0"],
          default: "2.0",
          schemaHashes: { "2.0": V2_HASH }
        })
      ),
      "3.0"
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_no_mutual_protocol"
    });
  });

  it("treats present null protocols as invalid rather than legacy", () => {
    expect(selectWorkflowActionProtocol(integrationContract(null), "auto")).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_advertisement_invalid"
    });
  });

  it.each([
    ["empty supported", { supported: [] }],
    ["duplicate supported", { supported: ["2.0", "2.0"] }],
    ["default outside supported", { supported: ["2.0"], default: "3.0", schemaHashes: { "2.0": V2_HASH } }],
    ["missing hash", { schemaHashes: { "2.0": V2_HASH } }],
    ["extra hash", { schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH, "4.0": `sha256:${"4".repeat(64)}` } }],
    ["malformed hash", { schemaHashes: { "2.0": V2_HASH, "3.0": "sha256:ABC" } }]
  ])("rejects %s advertisement before selection", (_label, overrides) => {
    expect(
      selectWorkflowActionProtocol(
        integrationContract(workflowActionAdvertisement(overrides)),
        "auto"
      )
    ).toMatchObject({ ok: false, reasonCode: "workflow_action_advertisement_invalid" });
  });

  it("does not downgrade after the selected advertised schema hash mismatches", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          schemaHashes: { "2.0": V2_HASH, "3.0": `sha256:${"0".repeat(64)}` }
        })
      ),
      "auto"
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_schema_hash_mismatch"
    });
  });

  it("does not downgrade after selected WorkflowAction 3.2 hash verification fails", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          supported: ["2.0", "3.0", "3.1", "3.2"],
          schemaHashes: {
            "2.0": V2_HASH,
            "3.0": V3_HASH,
            "3.1": V31_HASH,
            "3.2": `sha256:${"0".repeat(64)}`
          }
        })
      ),
      "auto"
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_schema_hash_mismatch"
    });
  });

  it("checks only the explicitly selected known hash after global coherence", () => {
    const result = selectWorkflowActionProtocol(
      integrationContract(
        workflowActionAdvertisement({
          schemaHashes: { "2.0": V2_HASH, "3.0": `sha256:${"0".repeat(64)}` }
        })
      ),
      "2.0"
    );
    expect(result).toMatchObject({ ok: true, value: { protocolVersion: "2.0" } });
  });

  it("requires the exact Kit and CLI identity", () => {
    const contract = integrationContract(workflowActionAdvertisement());
    contract.kit = { packageName: "not-visp-kit", cliName: "visp", version: "0.1.1" };
    expect(selectWorkflowActionProtocol(contract, "auto")).toMatchObject({
      ok: false,
      reasonCode: "unsupported_integration_contract"
    });
  });
});

describe("WorkflowAction strict schemas and adapters", () => {
  it("strictly rejects unknown v2 and nested v3 fields", () => {
    expect(workflowActionV2StrictSchema.safeParse({ ...workflowActionV2(), extra: true }).success).toBe(false);
    const v3 = workflowActionV3();
    expect(
      workflowActionV3StrictSchema.safeParse({
        ...v3,
        scope: { ...(v3.scope as object), extra: true }
      }).success
    ).toBe(false);
  });

  it("matches Kit's safe-integer boundary for v3 operation limits", () => {
    const action = workflowActionV3();
    const withMaxChangedFiles = (maxChangedFiles: number) => ({
      ...action,
      scope: {
        ...action.scope,
        operationLimits: available({
          version: "1.0",
          maxChangedFiles,
          dependencyChangesAllowed: false
        })
      }
    });

    expect(
      workflowActionV3StrictSchema.safeParse(withMaxChangedFiles(Number.MAX_SAFE_INTEGER)).success
    ).toBe(true);
    expect(
      workflowActionV3StrictSchema.safeParse(withMaxChangedFiles(Number.MAX_SAFE_INTEGER + 1))
        .success
    ).toBe(false);
    expect(workflowActionV3StrictSchema.safeParse(withMaxChangedFiles(1e20)).success).toBe(false);
  });

  it("rejects forged protocol-selection provenance at parse and normalization boundaries", () => {
    const wire = workflowActionV3StrictSchema.parse(workflowActionV3());
    const forged = {
      protocolVersion: "3.0",
      mode: "legacy_v2",
      localSchemaHash: V2_HASH,
      schemaHashVerification: { state: "legacy_unadvertised" }
    } as unknown as WorkflowActionProtocolSelection;

    expect(parseSelectedWorkflowAction(wire, forged)).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_protocol_mismatch"
    });
    expect(normalizeWorkflowAction(wire, forged)).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_semantics_invalid"
    });
  });

  it("normalizes v2 truthfully without manufacturing v3-only proof", () => {
    const wire = workflowActionV2StrictSchema.parse(workflowActionV2());
    const result = normalizeWorkflowAction(wire, advertisedSelection("2.0"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        normalizationVersion: "1.0",
        source: {
          protocolVersion: "2.0",
          selectionMode: "advertised",
          localSchemaHash: V2_HASH,
          schemaHashVerification: { state: "advertised_verified" }
        },
        sourceCanonicalVersion: { state: "unavailable", reasonCode: "not_in_protocol" },
        actionId: { state: "unavailable", reasonCode: "not_in_protocol" },
        phase: { state: "unavailable", reasonCode: "not_in_protocol" },
        sourcePhase: "implement",
        feature: { state: "unavailable", reasonCode: "not_in_protocol" },
        task: {
          id: "T001",
          title: { state: "unavailable", reasonCode: "not_in_protocol" },
          status: { state: "unavailable", reasonCode: "not_in_protocol" },
          dependsOn: { state: "unavailable", reasonCode: "not_in_protocol" },
          parallelizable: { state: "unavailable", reasonCode: "not_in_protocol" }
        },
        taskClass: { state: "unavailable", reasonCode: "not_in_protocol" },
        risk: {
          level: { state: "unavailable", reasonCode: "not_in_protocol" },
          factors: { state: "unavailable", reasonCode: "not_in_protocol" }
        },
        assurance: {
          level: "kit_strict",
          profile: { state: "unavailable", reasonCode: "not_in_protocol" },
          workflowStrictness: { state: "unavailable", reasonCode: "not_in_protocol" }
        },
        goal: "Implement the current task.",
        baseCommit: { state: "unavailable", reasonCode: "not_in_protocol" },
        requiredReads: [
          {
            id: { state: "unavailable", reasonCode: "not_in_protocol" },
            role: "policy",
            path: ".visp/policy.json",
            contentHash: `sha256:${"a".repeat(64)}`,
            freshness: { state: "unavailable", reasonCode: "not_in_protocol" }
          }
        ],
        scope: {
          writablePaths: ["src/feature.ts"],
          expectedPaths: { state: "unavailable", reasonCode: "not_in_protocol" },
          forbiddenPaths: ["package.json"],
          operationLimits: { state: "unavailable", reasonCode: "not_in_protocol" }
        },
        claims: { state: "unavailable", reasonCode: "not_in_protocol" },
        validationOracles: [
          {
            id: "AC001",
            claimId: { state: "unavailable", reasonCode: "not_in_protocol" },
            statement: "The feature works.",
            testable: { state: "unavailable", reasonCode: "not_in_protocol" },
            validationMethod: "unit"
          }
        ],
        requiredEvidence: { state: "unavailable", reasonCode: "not_in_protocol" },
        assuranceSummary: { state: "unavailable", reasonCode: "not_in_protocol" },
        policy: {
          status: { state: "unavailable", reasonCode: "not_in_protocol" },
          appliedOverrides: { state: "unavailable", reasonCode: "not_in_protocol" }
        },
        structuredFindings: { state: "unavailable", reasonCode: "not_in_protocol" },
        findingMessages: [],
        verdict: "ready",
        nextCommand: "visp implement"
      }
    });
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.requiredReads)).toBe(true);
    expect(Object.isFrozen(result.value.wire)).toBe(true);
    if (result.value.wire.protocolVersion !== "2.0") throw new Error("Expected v2 provenance.");
    expect(Object.isFrozen(result.value.wire.acceptanceOracles[0])).toBe(true);
    if (false) {
      // @ts-expect-error Normalized arrays are recursively readonly.
      result.value.validationCommands.push("pnpm build");
      // @ts-expect-error Raw wire provenance is recursively readonly.
      result.value.wire.validationCommands.push("pnpm build");
    }
  });

  it("canonicalizes v2 read and oracle ordering while retaining raw provenance order", () => {
    const wire = workflowActionV2StrictSchema.parse(
      workflowActionV2({
        requiredReads: [
          { path: "plans/z.json", role: "plan", sha256: "b".repeat(64) },
          { path: "policy/a.json", role: "policy", sha256: "a".repeat(64) },
          { path: "plans/a.json", role: "plan", sha256: "c".repeat(64) }
        ],
        acceptanceOracles: [
          { id: "AC010", expectedBehavior: "Later oracle.", validation: "integration" },
          { id: "AC002", expectedBehavior: "Earlier oracle.", validation: "unit" }
        ]
      })
    );
    const result = normalizeWorkflowAction(wire, advertisedSelection("2.0"));
    if (!result.ok) throw new Error(result.reason);

    expect(result.value.requiredReads.map((read) => [read.role, read.path])).toEqual([
      ["policy", "policy/a.json"],
      ["plan", "plans/a.json"],
      ["plan", "plans/z.json"]
    ]);
    expect(result.value.validationOracles.map((oracle) => oracle.id)).toEqual(["AC002", "AC010"]);
    if (result.value.wire.protocolVersion !== "2.0") throw new Error("Expected v2 provenance.");
    expect(result.value.wire.acceptanceOracles.map((oracle) => oracle.id)).toEqual([
      "AC010",
      "AC002"
    ]);
  });

  it("deep-freezes nested provenance even when the parsed wire root is already frozen", () => {
    const wire = workflowActionV2StrictSchema.parse(workflowActionV2());
    Object.freeze(wire);
    expect(Object.isFrozen(wire.requiredReads)).toBe(false);

    const result = normalizeWorkflowAction(wire, advertisedSelection("2.0"));
    if (!result.ok) throw new Error(result.reason);
    if (result.value.wire.protocolVersion !== "2.0") throw new Error("Expected v2 provenance.");

    expect(Object.isFrozen(result.value.wire.requiredReads)).toBe(true);
    expect(Object.isFrozen(result.value.wire.requiredReads[0])).toBe(true);
    expect(Object.isFrozen(result.value.wire.acceptanceOracles)).toBe(true);
  });

  it.each([
    ["unknown role", { requiredReads: [{ path: "src/a.ts", role: "mystery", sha256: "a".repeat(64) }] }],
    ["invalid hash", { requiredReads: [{ path: "src/a.ts", role: "policy", sha256: "ABC" }] }],
    ["unsafe path", { writablePaths: ["../escape.ts"] }],
    ["unknown validation method", { acceptanceOracles: [{ id: "AC001", expectedBehavior: "Works", validation: "magic" }] }],
    ["local assurance", { assuranceLevel: "local_checked" }]
  ])("rejects semantically invalid v2 %s", (_label, overrides) => {
    const wire = workflowActionV2StrictSchema.parse(workflowActionV2(overrides));
    expect(normalizeWorkflowAction(wire, advertisedSelection("2.0"))).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_semantics_invalid"
    });
  });

  it("independently verifies v3 action identity and preserves canonical availability", () => {
    const wire = workflowActionV3StrictSchema.parse(workflowActionV3());
    expect(createWorkflowActionV3Id(wire)).toBe(V3_ACTION_ID);
    const result = normalizeWorkflowAction(wire, advertisedSelection("3.0"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceCanonicalVersion: { state: "available", value: "1.0" },
        actionId: { state: "available", value: V3_ACTION_ID },
        phase: { state: "available", value: "implement" },
        feature: { state: "available", value: { id: "001", slug: "demo" } },
        task: { id: "T001", title: { state: "available", value: "Demo task" } },
        structuredFindings: { state: "available", value: [] }
      }
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.assuranceSummary).toEqual({
      state: "unavailable",
      reasonCode: "not_in_protocol"
    });
  });

  it("strictly validates 3.1 identity and preserves Kit-authored evidence without inference", () => {
    const wire = workflowActionV31StrictSchema.parse(workflowActionV31Fixture());
    expect(createWorkflowActionV31Id(wire)).toBe(wire.actionId);

    const parsed = parseSelectedWorkflowAction(wire, advertisedSelection("3.1"));
    expect(parsed).toMatchObject({ ok: true, value: { protocolVersion: "3.1" } });

    const result = normalizeWorkflowAction(wire, advertisedSelection("3.1"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceCanonicalVersion: { state: "available", value: "1.1" },
        evidence: {
          state: "available",
          value: {
            source: "candidate",
            freshness: "fresh",
            providers: [
              {
                status: "passed",
                results: [
                  {
                    independence: "pre_approved",
                    outcome: { status: "passed" }
                  }
                ]
              }
            ]
          }
        }
      }
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.evidence).toEqual(wire.evidence);
    expect(result.value.assuranceSummary).toEqual({
      state: "unavailable",
      reasonCode: "not_in_protocol"
    });
    expect(Object.isFrozen(result.value.evidence)).toBe(true);
  });

  it("strictly validates 3.2 identity and preserves Kit-authored assurance without inference", () => {
    const wire = workflowActionV32StrictSchema.parse(workflowActionV32Fixture());
    expect(createWorkflowActionV32Id(wire)).toBe(wire.actionId);

    const parsed = parseSelectedWorkflowAction(wire, advertisedSelection("3.2"));
    expect(parsed).toMatchObject({ ok: true, value: { protocolVersion: "3.2" } });

    const result = normalizeWorkflowAction(wire, advertisedSelection("3.2"));
    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceCanonicalVersion: { state: "available", value: "1.2" },
        assuranceSummary: {
          state: "available",
          caseHash: `sha256:${"e".repeat(64)}`,
          verdict: "inconclusive",
          mandatoryHotspots: [
            {
              id: "HS001",
              category: "security",
              severity: "critical",
              path: "src/feature.ts"
            }
          ],
          reviewDecision: {
            required: true,
            status: "missing",
            decisionHash: null
          }
        },
        nextCommand: 'visp gate implement --task "T001 exact" && printf opaque'
      }
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.assuranceSummary).toEqual(wire.assuranceSummary);
    expect(toHyperActionEnvelope(result.value).action.assuranceSummary).toEqual(
      wire.assuranceSummary
    );
    expect(Object.isFrozen(result.value.assuranceSummary)).toBe(true);
    if (result.value.assuranceSummary.state !== "available") {
      throw new Error("Expected available assurance summary.");
    }
    expect(Object.isFrozen(result.value.assuranceSummary.mandatoryHotspots)).toBe(true);
    expect(Object.isFrozen(result.value.assuranceSummary.reviewDecision)).toBe(true);
  });

  it.each([
    [
      "extra summary field",
      () => ({
        ...workflowActionV32Fixture(),
        assuranceSummary: {
          ...workflowActionV32Fixture().assuranceSummary,
          accepted: true
        }
      })
    ],
    [
      "unsafe artifact path",
      () => {
        const action = workflowActionV32Fixture();
        if (action.assuranceSummary.state !== "available") throw new Error("Expected summary.");
        return {
          ...action,
          assuranceSummary: {
            ...action.assuranceSummary,
            artifact: { ...action.assuranceSummary.artifact, path: "../case.json" }
          }
        };
      }
    ],
    [
      "invalid case hash",
      () => {
        const action = workflowActionV32Fixture();
        return {
          ...action,
          assuranceSummary: { ...action.assuranceSummary, caseHash: "sha256:ABC" }
        };
      }
    ],
    [
      "invalid review status",
      () => {
        const action = workflowActionV32Fixture();
        return {
          ...action,
          assuranceSummary: {
            ...action.assuranceSummary,
            reviewDecision: {
              ...action.assuranceSummary.reviewDecision,
              status: "accepted"
            }
          }
        };
      }
    ],
    [
      "unsorted hotspots",
      () => {
        const action = workflowActionV32Fixture();
        if (action.assuranceSummary.state !== "available") throw new Error("Expected summary.");
        const hotspot = action.assuranceSummary.mandatoryHotspots[0]!;
        return {
          ...action,
          assuranceSummary: {
            ...action.assuranceSummary,
            mandatoryHotspots: [
              { ...hotspot, id: "HS002" },
              { ...hotspot, id: "HS001" }
            ]
          }
        };
      }
    ],
    [
      "duplicate hotspots",
      () => {
        const action = workflowActionV32Fixture();
        if (action.assuranceSummary.state !== "available") throw new Error("Expected summary.");
        const hotspot = action.assuranceSummary.mandatoryHotspots[0]!;
        return {
          ...action,
          assuranceSummary: {
            ...action.assuranceSummary,
            mandatoryHotspots: [hotspot, hotspot]
          }
        };
      }
    ],
    [
      "non-null unavailable decision hash",
      () => ({
        ...workflowActionV32Fixture(),
        assuranceSummary: {
          state: "unavailable",
          reason: "Assurance case is missing.",
          reviewDecision: {
            required: true,
            status: "missing",
            decisionHash: `sha256:${"f".repeat(64)}`,
            reason: "No decision is recorded."
          }
        }
      })
    ]
  ])("strictly rejects malformed 3.2 %s", (_label, mutate) => {
    expect(workflowActionV32StrictSchema.safeParse(mutate()).success).toBe(false);
  });

  it("rejects a 3.2 assurance summary changed after identity generation", () => {
    const valid = workflowActionV32Fixture();
    if (valid.assuranceSummary.state !== "available") throw new Error("Expected summary.");
    const tampered = workflowActionV32StrictSchema.parse({
      ...valid,
      assuranceSummary: {
        ...valid.assuranceSummary,
        reviewDecision: {
          ...valid.assuranceSummary.reviewDecision,
          reason: "The case changed after identity generation."
        }
      }
    });
    expect(normalizeWorkflowAction(tampered, advertisedSelection("3.2"))).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_identity_invalid"
    });
  });

  it("preserves Kit's unavailable 3.2 assurance summary without reinterpretation", () => {
    const assuranceSummary = {
      state: "unavailable" as const,
      reason: "The assurance case is missing.",
      reviewDecision: {
        required: true,
        status: "missing" as const,
        decisionHash: null,
        reason: "No review decision is recorded."
      }
    };
    const wire = workflowActionV32StrictSchema.parse(
      workflowActionV32Fixture({ assuranceSummary })
    );
    const result = normalizeWorkflowAction(wire, advertisedSelection("3.2"));
    if (!result.ok) throw new Error(result.reason);

    expect(result.value.assuranceSummary).toEqual(assuranceSummary);
    expect(Object.isFrozen(result.value.assuranceSummary)).toBe(true);
    if (!("reviewDecision" in result.value.assuranceSummary)) {
      throw new Error("Expected Kit-authored unavailable assurance summary.");
    }
    expect(Object.isFrozen(result.value.assuranceSummary.reviewDecision)).toBe(true);
  });

  it("fails closed for malformed or tampered 3.1 evidence and identity", () => {
    const valid = workflowActionV31Fixture();
    expect(
      workflowActionV31StrictSchema.safeParse({
        ...valid,
        evidence: {
          ...valid.evidence,
          unexpected: true
        }
      }).success
    ).toBe(false);

    const tampered = workflowActionV31StrictSchema.parse({
      ...valid,
      evidence: unavailable("source_invalid")
    });
    expect(normalizeWorkflowAction(tampered, advertisedSelection("3.1"))).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_identity_invalid"
    });
  });

  it("rejects a v3 identity mismatch and verdict/finding contradiction", () => {
    const badId = workflowActionV3StrictSchema.parse(
      workflowActionV3({ actionId: `sha256:${"0".repeat(64)}` })
    );
    expect(normalizeWorkflowAction(badId, advertisedSelection("3.0"))).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_identity_invalid"
    });

    const contradictory = {
      ...workflowActionV3(),
      findings: [
        {
          code: "VISP.TEST.BLOCK",
          source: "workflow",
          severity: "error",
          effect: "blocks",
          message: "Blocked.",
          recommendation: "Fix it.",
          evidence: []
        }
      ]
    };
    contradictory.actionId = createWorkflowActionV3Id(
      workflowActionV3StrictSchema.parse({
        ...contradictory,
        actionId: `sha256:${"0".repeat(64)}`
      })
    );
    const wire = workflowActionV3StrictSchema.parse(contradictory);
    expect(normalizeWorkflowAction(wire, advertisedSelection("3.0"))).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_contradiction"
    });
  });

  it.each([
    ["passed", { status: "passed" }],
    ["failed", { status: "failed", reason: "The required command failed." }],
    ["inconclusive", { status: "inconclusive", reason: "The provider was unavailable." }],
    [
      "not_applicable",
      {
        status: "not_applicable",
        reason: "The declared rule does not apply.",
        determination: { kind: "rule", ruleId: "VSP999" }
      }
    ]
  ] as const)("renders Kit's %s evidence outcome without reinterpretation", (_status, outcome) => {
    const base = workflowActionV31Fixture();
    if (base.evidence.state !== "available") throw new Error("Expected available evidence.");
    const evidence = {
      state: "available" as const,
      value: {
        ...base.evidence.value,
        outcome: outcome.status,
        providers: base.evidence.value.providers.map((provider, providerIndex) => ({
          ...provider,
          status: outcome.status === "inconclusive" ? "inconclusive" as const : provider.status,
          failure:
            outcome.status === "inconclusive"
              ? {
                  code: "skipped_evidence" as const,
                  reason: "The provider was unavailable."
                }
              : provider.failure,
          results: provider.results.map((result, resultIndex) => ({
            ...result,
            outcome:
              providerIndex === 0 && resultIndex === 0
                ? outcome
                : result.outcome
          }))
        }))
      }
    };
    const wire = workflowActionV31Fixture({ evidence });
    const normalized = normalizeWorkflowAction(wire, advertisedSelection("3.1"));
    if (!normalized.ok) throw new Error(normalized.reason);

    expect(toHyperActionEnvelope(normalized.value).action.evidence).toEqual(evidence);
  });

  it("preserves equivalent overlapping v2 and v3 meaning", () => {
    const v2 = normalizeWorkflowAction(
      workflowActionV2StrictSchema.parse(workflowActionV2()),
      advertisedSelection("2.0")
    );
    const v3 = normalizeWorkflowAction(
      workflowActionV3StrictSchema.parse(workflowActionV3()),
      advertisedSelection("3.0")
    );
    if (!v2.ok || !v3.ok) throw new Error("Expected both fixtures to normalize.");
    expect({
      taskId: v2.value.task?.id,
      goal: v2.value.goal,
      reads: v2.value.requiredReads.map((read) => [read.path, read.contentHash]),
      writable: v2.value.scope.writablePaths,
      forbidden: v2.value.scope.forbiddenPaths,
      commands: v2.value.validationCommands,
      assurance: v2.value.assurance.level,
      verdict: v2.value.verdict,
      nextCommand: v2.value.nextCommand
    }).toEqual({
      taskId: v3.value.task?.id,
      goal: v3.value.goal,
      reads: v3.value.requiredReads.map((read) => [read.path, read.contentHash]),
      writable: v3.value.scope.writablePaths,
      forbidden: v3.value.scope.forbiddenPaths,
      commands: v3.value.validationCommands,
      assurance: v3.value.assurance.level,
      verdict: v3.value.verdict,
      nextCommand: v3.value.nextCommand
    });
  });
});
