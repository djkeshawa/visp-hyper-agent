import { z } from "zod";

export const WORKFLOW_ACTION_PROTOCOL_PREFERENCE = Object.freeze([
  "3.2",
  "3.1",
  "3.0",
  "2.0"
] as const);
export type WorkflowActionProtocol = (typeof WORKFLOW_ACTION_PROTOCOL_PREFERENCE)[number];
export type WorkflowActionPreference = "auto" | WorkflowActionProtocol;

export const TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES = Object.freeze({
  "2.0": "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6",
  "3.0": "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7",
  "3.1": "sha256:41ffa28fcd4476ea1812ff307df67a7ab7edb5b2cf4d6c11955d34d4aad74d4d",
  "3.2": "sha256:77dcaba51ef8e1a78064680077f8bcc48c081d8025596c6cc8df9ea7873d68e9"
} as const satisfies Readonly<Record<WorkflowActionProtocol, `sha256:${string}`>>);

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const nonEmptyStringSchema = z.string().min(1);
const idSchema = nonEmptyStringSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const projectPathSchema = nonEmptyStringSchema.regex(
  /^(?!\/)(?![A-Za-z]:\/)(?!.*[\\\x00])(?!\.{1,2}(?:\/|$))(?!.+\/\.{1,2}(?:\/|$))(?!.*[/][/])(?!.+\/$).+$/u
);

const unavailableReasonSchema = z.enum([
  "not_in_source_artifact",
  "not_in_protocol",
  "source_missing",
  "source_invalid",
  "not_captured",
  "unsupported"
]);
const notApplicableReasonSchema = z.enum([
  "no_active_feature",
  "no_active_task",
  "stage_does_not_require_value"
]);

function declaredValueSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("available"), value: valueSchema }).strict(),
    z.object({ state: z.literal("unavailable"), reasonCode: unavailableReasonSchema }).strict(),
    z.object({ state: z.literal("not_applicable"), reasonCode: notApplicableReasonSchema }).strict()
  ]);
}

export const workflowActionV2StrictSchema = z
  .object({
    protocolVersion: z.literal("2.0"),
    phase: z.enum(["clarify", "specify", "plan", "task", "implement", "verify"]),
    taskId: z.string().nullable(),
    goal: z.string(),
    requiredReads: z.array(
      z.object({ path: z.string(), role: z.string(), sha256: z.string() }).strict()
    ),
    writablePaths: z.array(z.string()),
    forbiddenPaths: z.array(z.string()),
    acceptanceOracles: z.array(
      z
        .object({ id: z.string(), expectedBehavior: z.string(), validation: z.string() })
        .strict()
    ),
    validationCommands: z.array(z.string()),
    assuranceLevel: z.enum(["kit_strict", "local_checked", "advisory"]),
    verdict: z.enum(["ready", "blocked", "inconclusive"]),
    findings: z.array(z.string()),
    nextCommand: z.string()
  })
  .strict();

const workflowPhaseSchema = z.enum([
  "next",
  "setup",
  "feature",
  "clarify",
  "spec",
  "plan",
  "tasks",
  "context",
  "implement",
  "verify",
  "review",
  "reconcile",
  "pr"
]);
const featureSchema = z.object({ id: idSchema, slug: nonEmptyStringSchema }).strict();
const taskSchema = z
  .object({
    id: idSchema,
    title: nonEmptyStringSchema,
    status: z.enum(["pending", "ready", "in_progress", "blocked", "done", "verified"]),
    dependsOn: z.array(idSchema),
    parallelizable: z.boolean()
  })
  .strict();
export const taskClassValues = [
  "localized_bug",
  "bounded_feature",
  "cross_file_change",
  "regression_test",
  "refactor",
  "migration",
  "security",
  "documentation"
] as const;
export const taskClassSchema = z.enum(taskClassValues);

export const riskLevelValues = ["low", "medium", "high"] as const;
export const riskLevelSchema = z.enum(riskLevelValues);

export const assuranceProfileValues = ["routine", "behavioral", "critical"] as const;
export const assuranceProfileSchema = z.enum(assuranceProfileValues);

export const riskFactorCodeValues = [
  "authentication",
  "authorization",
  "cryptography",
  "public_api",
  "schema",
  "dependency",
  "concurrency",
  "permissions",
  "deployment",
  "data_migration"
] as const;
export const riskFactorCodeSchema = z.enum(riskFactorCodeValues);
export const riskFactorSchema = z
  .object({
    version: z.literal("1.0"),
    code: riskFactorCodeSchema
  })
  .strict();
export const riskFactorsSchema = z.array(riskFactorSchema);

export type TaskClass = z.infer<typeof taskClassSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type AssuranceProfile = z.infer<typeof assuranceProfileSchema>;
export type RiskFactorCode = z.infer<typeof riskFactorCodeSchema>;
export type RiskFactor = z.infer<typeof riskFactorSchema>;
const hashedReadSchema = z
  .object({
    id: idSchema,
    role: z.enum([
      "policy",
      "intent",
      "specification",
      "plan",
      "task_graph",
      "context_pack",
      "implementation_prompt",
      "oracle_plan"
    ]),
    path: projectPathSchema,
    contentHash: sha256Schema,
    freshness: z.literal("content_hash")
  })
  .strict();
const operationLimitsSchema = z
  .object({
    version: z.literal("1.0"),
    maxChangedFiles: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    dependencyChangesAllowed: z.boolean()
  })
  .strict();
const requirementClaimSchema = z
  .object({
    id: idSchema,
    statement: nonEmptyStringSchema,
    priority: z.enum(["must", "should", "could"]),
    acceptanceCriterionIds: z.array(idSchema),
    accountableOwner: declaredValueSchema(nonEmptyStringSchema)
  })
  .strict();
const validationOracleSchema = z
  .object({
    id: idSchema,
    claimId: idSchema,
    statement: nonEmptyStringSchema,
    testable: z.boolean(),
    validationMethod: z.enum(["unit", "integration", "e2e", "manual", "static"])
  })
  .strict();
const evidenceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("command"), command: nonEmptyStringSchema }).strict(),
  z.object({ kind: z.literal("validation_oracle"), oracleId: idSchema }).strict(),
  z.object({ kind: z.literal("static_check"), checkId: idSchema }).strict(),
  z.object({ kind: z.literal("security_check"), checkId: idSchema }).strict(),
  z.object({ kind: z.literal("human_review"), reviewId: idSchema }).strict()
]);
const evidenceRequirementSchema = z
  .object({
    version: z.literal("1.0"),
    id: idSchema,
    providerId: idSchema,
    target: evidenceTargetSchema,
    freshnessRule: nonEmptyStringSchema,
    independenceRule: nonEmptyStringSchema,
    requiredVerdict: z.literal("passed")
  })
  .strict();
const appliedPolicyOverrideSchema = z
  .object({
    overrideId: idSchema,
    ruleId: idSchema,
    scope: z.enum(["project", "feature", "task", "stage"]),
    reason: nonEmptyStringSchema,
    expiresAt: z.string().datetime().nullable(),
    appliedToStage: workflowPhaseSchema,
    appliedToFeatureId: idSchema.nullable(),
    appliedToTaskId: idSchema.nullable()
  })
  .strict();
const findingSchema = z
  .object({
    code: nonEmptyStringSchema,
    source: z.enum(["policy", "workflow", "contract", "freshness"]),
    severity: z.enum(["info", "warning", "error"]),
    effect: z.enum(["none", "blocks", "uncertain"]),
    message: nonEmptyStringSchema,
    recommendation: nonEmptyStringSchema,
    evidence: z.array(z.string())
  })
  .strict();

export const workflowActionV3StrictSchema = z
  .object({
    protocolVersion: z.literal("3.0"),
    canonicalVersion: z.literal("1.0"),
    actionId: sha256Schema,
    phase: workflowPhaseSchema,
    feature: featureSchema.nullable(),
    task: taskSchema.nullable(),
    taskClass: declaredValueSchema(taskClassSchema),
    risk: z
      .object({
        level: declaredValueSchema(riskLevelSchema),
        factors: declaredValueSchema(riskFactorsSchema)
      })
      .strict(),
    assurance: z
      .object({
        level: z.enum(["kit_strict", "advisory"]),
        profile: declaredValueSchema(assuranceProfileSchema),
        workflowStrictness: declaredValueSchema(
          z.enum(["relaxed", "standard", "strict", "locked"])
        )
      })
      .strict(),
    goal: nonEmptyStringSchema,
    baseCommit: declaredValueSchema(nonEmptyStringSchema),
    requiredReads: z.array(hashedReadSchema),
    scope: z
      .object({
        writablePaths: z.array(projectPathSchema),
        expectedPaths: declaredValueSchema(z.array(projectPathSchema)),
        forbiddenPaths: z.array(projectPathSchema),
        operationLimits: declaredValueSchema(operationLimitsSchema)
      })
      .strict(),
    claims: declaredValueSchema(z.array(requirementClaimSchema)),
    validationOracles: z.array(validationOracleSchema),
    validationCommands: z.array(nonEmptyStringSchema),
    requiredEvidence: declaredValueSchema(z.array(evidenceRequirementSchema)),
    policy: z
      .object({
        status: declaredValueSchema(z.enum(["valid", "missing", "invalid", "default"])),
        appliedOverrides: declaredValueSchema(z.array(appliedPolicyOverrideSchema))
      })
      .strict(),
    findings: z.array(findingSchema),
    verdict: z.enum(["ready", "blocked", "inconclusive"]),
    nextCommand: nonEmptyStringSchema
  })
  .strict();

const evidenceInputHashSchema = z
  .object({
    id: idSchema,
    sha256: sha256Schema
  })
  .strict();
const evidenceFreshnessSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("fresh"),
      checkedAt: z.string().datetime(),
      inputHashes: z.array(evidenceInputHashSchema)
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      checkedAt: z.string().datetime(),
      inputHashes: z.array(evidenceInputHashSchema),
      reason: nonEmptyStringSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("unknown"),
      checkedAt: z.string().datetime(),
      inputHashes: z.array(evidenceInputHashSchema),
      reason: nonEmptyStringSchema
    })
    .strict()
]);
const notApplicableDeterminationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rule"), ruleId: idSchema }).strict(),
  z.object({ kind: z.literal("override"), overrideId: idSchema }).strict()
]);
const evidenceOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("passed") }).strict(),
  z.object({ status: z.literal("failed"), reason: nonEmptyStringSchema }).strict(),
  z.object({ status: z.literal("inconclusive"), reason: nonEmptyStringSchema }).strict(),
  z
    .object({
      status: z.literal("not_applicable"),
      reason: nonEmptyStringSchema,
      determination: notApplicableDeterminationSchema
    })
    .strict()
]);
const evidenceResultSummarySchema = z
  .object({
    id: idSchema,
    requirementId: idSchema,
    target: evidenceTargetSchema,
    freshness: evidenceFreshnessSchema,
    independence: z.enum([
      "pre_existing",
      "pre_approved",
      "implementer_authored",
      "independent_challenger",
      "human_attestation"
    ]),
    outcome: evidenceOutcomeSchema
  })
  .strict();
const evidenceProviderSummarySchema = z
  .object({
    id: idSchema,
    provider: z
      .object({
        id: idSchema,
        version: nonEmptyStringSchema
      })
      .strict(),
    status: z.enum(["passed", "inconclusive"]),
    failure: z
      .object({
        code: z.enum([
          "unsupported_provider",
          "malformed_output",
          "timeout",
          "command_not_found",
          "skipped_evidence"
        ]),
        reason: nonEmptyStringSchema
      })
      .strict()
      .nullable(),
    results: z.array(evidenceResultSummarySchema)
  })
  .strict();
const evidenceSummarySchema = z
  .object({
    version: z.literal("1.0"),
    source: z.enum(["baseline", "candidate"]),
    artifact: z
      .object({
        path: projectPathSchema,
        contentHash: sha256Schema
      })
      .strict(),
    generatedAt: z.string().datetime(),
    outcome: z.enum(["passed", "failed", "inconclusive", "not_applicable"]),
    freshness: z.enum(["fresh", "stale", "unknown"]),
    providers: z.array(evidenceProviderSummarySchema),
    testStrength: declaredValueSchema(
      z
        .object({
          status: z.enum(["passed", "inconclusive"]),
          independence: z.array(z.enum(["pre_existing", "pre_approved"])),
          reason: nonEmptyStringSchema
        })
        .strict()
    )
  })
  .strict();

export const workflowActionV31StrictSchema = workflowActionV3StrictSchema
  .extend({
    protocolVersion: z.literal("3.1"),
    canonicalVersion: z.literal("1.1"),
    evidence: declaredValueSchema(evidenceSummarySchema)
  })
  .strict();

const assuranceReviewDecisionSchema = z
  .object({
    required: z.boolean(),
    status: z.enum(["current", "missing", "rejected", "stale", "invalid"]),
    decisionHash: sha256Schema.nullable(),
    reason: nonEmptyStringSchema
  })
  .strict();
const mandatoryHotspotSchema = z
  .object({
    id: idSchema,
    category: z.enum([
      "public_api",
      "dependency",
      "schema_migration",
      "security",
      "concurrency",
      "permissions",
      "deployment_configuration",
      "test_deletion",
      "test_weakening",
      "validation_command_change",
      "unmapped_change",
      "scope_expansion",
      "oversized_scope",
      "inconclusive_evidence",
      "override_usage",
      "generated_behavior"
    ]),
    severity: z.enum(["critical", "high", "medium"]),
    path: projectPathSchema.nullable(),
    reason: nonEmptyStringSchema
  })
  .strict();
const availableAssuranceSummarySchema = z
  .object({
    state: z.literal("available"),
    version: z.literal("1.0"),
    artifact: z
      .object({
        path: projectPathSchema,
        contentHash: sha256Schema
      })
      .strict(),
    caseHash: sha256Schema,
    verdict: z.enum(["passed", "failed", "inconclusive"]),
    mandatoryHotspots: z.array(mandatoryHotspotSchema),
    reviewDecision: assuranceReviewDecisionSchema
  })
  .strict()
  .superRefine((summary, context) => {
    for (const [index, hotspot] of summary.mandatoryHotspots.entries()) {
      const previous = summary.mandatoryHotspots[index - 1];
      if (previous === undefined) continue;
      const fields: Array<[string, string]> = [
        [previous.id, hotspot.id],
        [previous.category, hotspot.category],
        [previous.severity, hotspot.severity],
        [previous.path ?? "", hotspot.path ?? ""],
        [previous.reason, hotspot.reason]
      ];
      let comparison = 0;
      for (const [left, right] of fields) {
        comparison = compareCodeUnits(left, right);
        if (comparison !== 0) break;
      }
      if (comparison >= 0) {
        context.addIssue({
          code: "custom",
          path: ["mandatoryHotspots", index],
          message: "Mandatory hotspots must use stable UTF-16 order and be unique."
        });
      }
    }
  });
const assuranceSummarySchema = z.union([
  availableAssuranceSummarySchema,
  z
    .object({
      state: z.literal("unavailable"),
      reason: nonEmptyStringSchema,
      reviewDecision: assuranceReviewDecisionSchema.extend({
        decisionHash: z.null()
      })
    })
    .strict()
]);

export const workflowActionV32StrictSchema = workflowActionV31StrictSchema
  .extend({
    protocolVersion: z.literal("3.2"),
    canonicalVersion: z.literal("1.2"),
    assuranceSummary: assuranceSummarySchema
  })
  .strict();

export type WorkflowActionV2Wire = z.infer<typeof workflowActionV2StrictSchema>;
export type WorkflowActionV3Wire = z.infer<typeof workflowActionV3StrictSchema>;
export type WorkflowActionV31Wire = z.infer<typeof workflowActionV31StrictSchema>;
export type WorkflowActionV32Wire = z.infer<typeof workflowActionV32StrictSchema>;
export type WorkflowActionWire =
  | WorkflowActionV2Wire
  | WorkflowActionV3Wire
  | WorkflowActionV31Wire
  | WorkflowActionV32Wire;

export type WorkflowActionProtocolSelection =
  | Readonly<{
      protocolVersion: "2.0";
      mode: "legacy_v2";
      localSchemaHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["2.0"];
      schemaHashVerification: Readonly<{ state: "legacy_unadvertised" }>;
    }>
  | Readonly<{
      protocolVersion: "2.0";
      mode: "advertised";
      localSchemaHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["2.0"];
      schemaHashVerification: Readonly<{
        state: "advertised_verified";
        advertisedHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["2.0"];
      }>;
    }>
  | Readonly<{
      protocolVersion: "3.0";
      mode: "advertised";
      localSchemaHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.0"];
      schemaHashVerification: Readonly<{
        state: "advertised_verified";
        advertisedHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.0"];
      }>;
    }>
  | Readonly<{
      protocolVersion: "3.1";
      mode: "advertised";
      localSchemaHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.1"];
      schemaHashVerification: Readonly<{
        state: "advertised_verified";
        advertisedHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.1"];
      }>;
    }>
  | Readonly<{
      protocolVersion: "3.2";
      mode: "advertised";
      localSchemaHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.2"];
      schemaHashVerification: Readonly<{
        state: "advertised_verified";
        advertisedHash: (typeof TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES)["3.2"];
      }>;
    }>;

export type WorkflowActionProtocolReasonCode =
  | "unsupported_integration_contract"
  | "workflow_action_advertisement_invalid"
  | "workflow_action_no_mutual_protocol"
  | "workflow_action_schema_hash_mismatch"
  | "unsupported_workflow_action"
  | "workflow_action_protocol_mismatch"
  | "workflow_action_schema_invalid";

export type WorkflowActionProtocolResult<T> =
  | { ok: true; value: T }
  | { ok: false; reasonCode: WorkflowActionProtocolReasonCode; reason: string };

const workflowActionAdvertisementSchema = z
  .object({
    supported: z.array(nonEmptyStringSchema).min(1),
    default: nonEmptyStringSchema,
    schemaHashes: z.record(sha256Schema)
  })
  .passthrough();
const protocolsSchema = z
  .object({ workflowAction: workflowActionAdvertisementSchema })
  .passthrough();

export function selectWorkflowActionProtocol(
  contract: unknown,
  preference: WorkflowActionPreference = "auto"
): WorkflowActionProtocolResult<WorkflowActionProtocolSelection> {
  if (!isRecord(contract) || contract.contractVersion !== "2.0") {
    return failure(
      "unsupported_integration_contract",
      "WorkflowAction negotiation requires Kit integration contract 2.0."
    );
  }
  const kit = isRecord(contract.kit) ? contract.kit : undefined;
  if (kit?.packageName !== "visp-kit" || kit.cliName !== "visp") {
    return failure(
      "unsupported_integration_contract",
      "WorkflowAction negotiation requires Kit identity visp-kit/visp."
    );
  }

  if (!Object.prototype.hasOwnProperty.call(contract, "protocols")) {
    if (preference !== "auto" && preference !== "2.0") {
      return failure(
        "workflow_action_no_mutual_protocol",
        `Legacy integration contract 2.0 does not advertise WorkflowAction ${preference}.`
      );
    }
    return success(
      deepFreeze({
        protocolVersion: "2.0",
        mode: "legacy_v2",
        localSchemaHash: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"],
        schemaHashVerification: { state: "legacy_unadvertised" }
      })
    );
  }

  const parsed = protocolsSchema.safeParse(contract.protocols);
  if (!parsed.success) {
    return invalidAdvertisement("known protocol metadata is missing or malformed");
  }
  const advertisement = parsed.data.workflowAction;
  const supported = advertisement.supported;
  if (new Set(supported).size !== supported.length) {
    return invalidAdvertisement("supported versions contain duplicates");
  }
  if (!supported.includes(advertisement.default)) {
    return invalidAdvertisement("default is not a supported version");
  }
  const supportedKeys = [...supported].sort(compareCodeUnits);
  const hashKeys = Object.keys(advertisement.schemaHashes).sort(compareCodeUnits);
  if (
    supportedKeys.length !== hashKeys.length ||
    supportedKeys.some((version, index) => version !== hashKeys[index])
  ) {
    return invalidAdvertisement("schema-hash keys do not exactly match supported versions");
  }

  const selected =
    preference === "auto"
      ? WORKFLOW_ACTION_PROTOCOL_PREFERENCE.find((version) => supported.includes(version))
      : supported.includes(preference)
        ? preference
        : undefined;
  if (selected === undefined) {
    return failure(
      "workflow_action_no_mutual_protocol",
      `No mutually supported WorkflowAction protocol exists for preference ${preference}.`
    );
  }

  const advertisedHash = advertisement.schemaHashes[selected] as `sha256:${string}`;
  const localSchemaHash = TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES[selected];
  if (advertisedHash !== localSchemaHash) {
    return failure(
      "workflow_action_schema_hash_mismatch",
      `Advertised WorkflowAction ${selected} schema hash ${advertisedHash} does not match local trust anchor ${localSchemaHash}.`
    );
  }

  return success(
    deepFreeze({
      protocolVersion: selected,
      mode: "advertised",
      localSchemaHash,
      schemaHashVerification: {
        state: "advertised_verified",
        advertisedHash: localSchemaHash
      }
    }) as WorkflowActionProtocolSelection
  );
}

export function isWorkflowActionProtocolSelection(
  value: unknown
): value is WorkflowActionProtocolSelection {
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocolVersion",
    "mode",
    "localSchemaHash",
    "schemaHashVerification"
  ])) {
    return false;
  }
  const protocolVersion = value.protocolVersion;
  if (
    protocolVersion !== "2.0" &&
    protocolVersion !== "3.0" &&
    protocolVersion !== "3.1" &&
    protocolVersion !== "3.2"
  ) {
    return false;
  }
  const expectedHash = TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES[protocolVersion];
  if (value.localSchemaHash !== expectedHash || !isRecord(value.schemaHashVerification)) {
    return false;
  }
  if (value.mode === "legacy_v2") {
    return (
      protocolVersion === "2.0" &&
      hasExactKeys(value.schemaHashVerification, ["state"]) &&
      value.schemaHashVerification.state === "legacy_unadvertised"
    );
  }
  return (
    value.mode === "advertised" &&
    hasExactKeys(value.schemaHashVerification, ["state", "advertisedHash"]) &&
    value.schemaHashVerification.state === "advertised_verified" &&
    value.schemaHashVerification.advertisedHash === expectedHash
  );
}

export function parseSelectedWorkflowAction(
  payload: unknown,
  selection: WorkflowActionProtocolSelection
): WorkflowActionProtocolResult<WorkflowActionWire> {
  if (!isWorkflowActionProtocolSelection(selection)) {
    return failure(
      "workflow_action_protocol_mismatch",
      "WorkflowAction protocol selection provenance is internally incoherent."
    );
  }
  if (isUnsupportedWorkflowActionProtocolError(payload)) {
    return failure(
      "unsupported_workflow_action",
      "Kit rejected the selected WorkflowAction protocol."
    );
  }
  if (!isRecord(payload) || typeof payload.protocolVersion !== "string") {
    return failure(
      "workflow_action_schema_invalid",
      `WorkflowAction ${selection.protocolVersion} response is not a versioned JSON object.`
    );
  }
  const responseVersion = payload.protocolVersion;
  if (
    typeof responseVersion === "string" &&
    !WORKFLOW_ACTION_PROTOCOL_PREFERENCE.includes(responseVersion as WorkflowActionProtocol)
  ) {
    return failure(
      "unsupported_workflow_action",
      `Kit returned unsupported WorkflowAction protocol ${responseVersion}.`
    );
  }
  if (responseVersion !== selection.protocolVersion) {
    return failure(
      "workflow_action_protocol_mismatch",
      `Kit returned WorkflowAction protocol ${String(responseVersion)}; selected ${selection.protocolVersion}.`
    );
  }
  const schema =
    selection.protocolVersion === "2.0"
      ? workflowActionV2StrictSchema
      : selection.protocolVersion === "3.0"
        ? workflowActionV3StrictSchema
        : selection.protocolVersion === "3.1"
          ? workflowActionV31StrictSchema
          : workflowActionV32StrictSchema;
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return failure(
      "workflow_action_schema_invalid",
      `WorkflowAction ${selection.protocolVersion} did not match Hyper's strict local schema.`
    );
  }
  return success(parsed.data);
}

function isUnsupportedWorkflowActionProtocolError(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.error)) return false;
  return payload.error.code === "UNSUPPORTED_WORKFLOW_ACTION_PROTOCOL";
}

function invalidAdvertisement(detail: string): WorkflowActionProtocolResult<never> {
  return failure(
    "workflow_action_advertisement_invalid",
    `Kit WorkflowAction protocol advertisement is invalid: ${detail}.`
  );
}

function success<T>(value: T): WorkflowActionProtocolResult<T> {
  return { ok: true, value };
}

function failure(
  reasonCode: WorkflowActionProtocolReasonCode,
  reason: string
): WorkflowActionProtocolResult<never> {
  return { ok: false, reasonCode, reason };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sortedExpected = [...expected].sort(compareCodeUnits);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
