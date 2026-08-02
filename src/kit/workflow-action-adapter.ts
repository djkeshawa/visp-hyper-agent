import { createHash } from "node:crypto";
import {
  isWorkflowActionProtocolSelection,
  workflowActionV31StrictSchema,
  workflowActionV32StrictSchema,
  workflowActionV34StrictSchema,
  workflowActionV3StrictSchema,
  type WorkflowActionProtocolSelection,
  type WorkflowActionV2Wire,
  type WorkflowActionV31Wire,
  type WorkflowActionV32Wire,
  type WorkflowActionV3Wire,
  type WorkflowActionV34Wire,
  type WorkflowActionWire
} from "./workflow-action-protocol.js";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type NormalizedDeclaredValue<T> =
  | Readonly<{ state: "available"; value: DeepReadonly<T> }>
  | Readonly<{
      state: "unavailable";
      reasonCode:
        | "not_in_source_artifact"
        | "not_in_protocol"
        | "source_missing"
        | "source_invalid"
        | "not_captured"
        | "unsupported";
    }>
  | Readonly<{
      state: "not_applicable";
      reasonCode: "no_active_feature" | "no_active_task" | "stage_does_not_require_value";
    }>;

type WorkflowPhase = WorkflowActionV3Wire["phase"];
type TaskStatus = NonNullable<WorkflowActionV3Wire["task"]>["status"];
type ReadRole = WorkflowActionV3Wire["requiredReads"][number]["role"];
type ValidationMethod = WorkflowActionV3Wire["validationOracles"][number]["validationMethod"];

export type NormalizedWorkflowAction = DeepReadonly<{
  normalizationVersion: "1.0";
  source: Readonly<{
    protocolVersion: WorkflowActionWire["protocolVersion"];
    selectionMode: WorkflowActionProtocolSelection["mode"];
    localSchemaHash: WorkflowActionProtocolSelection["localSchemaHash"];
    schemaHashVerification: WorkflowActionProtocolSelection["schemaHashVerification"];
  }>;
  sourceCanonicalVersion: NormalizedDeclaredValue<"1.0" | "1.1" | "1.2" | "1.3">;
  actionId: NormalizedDeclaredValue<string>;
  phase: NormalizedDeclaredValue<WorkflowPhase>;
  sourcePhase: WorkflowActionWire["phase"];
  feature: NormalizedDeclaredValue<WorkflowActionV3Wire["feature"]>;
  task: null | Readonly<{
    id: string;
    title: NormalizedDeclaredValue<string>;
    status: NormalizedDeclaredValue<TaskStatus>;
    dependsOn: NormalizedDeclaredValue<readonly string[]>;
    parallelizable: NormalizedDeclaredValue<boolean>;
  }>;
  taskClass: WorkflowActionV3Wire["taskClass"];
  risk: Readonly<{
    level: WorkflowActionV3Wire["risk"]["level"];
    factors: WorkflowActionV3Wire["risk"]["factors"];
  }>;
  assurance: Readonly<{
    level: WorkflowActionV2Wire["assuranceLevel"];
    profile: WorkflowActionV3Wire["assurance"]["profile"];
    workflowStrictness: WorkflowActionV3Wire["assurance"]["workflowStrictness"];
  }>;
  goal: string;
  baseCommit: WorkflowActionV3Wire["baseCommit"];
  requiredReads: readonly Readonly<{
    id: NormalizedDeclaredValue<string>;
    role: ReadRole;
    path: string;
    contentHash: `sha256:${string}`;
    freshness: NormalizedDeclaredValue<"content_hash">;
  }>[];
  scope: Readonly<{
    writablePaths: readonly string[];
    expectedPaths: WorkflowActionV3Wire["scope"]["expectedPaths"];
    forbiddenPaths: readonly string[];
    operationLimits: WorkflowActionV3Wire["scope"]["operationLimits"];
  }>;
  claims: WorkflowActionV3Wire["claims"];
  validationOracles: readonly Readonly<{
    id: string;
    claimId: NormalizedDeclaredValue<string>;
    statement: string;
    testable: NormalizedDeclaredValue<boolean>;
    validationMethod: ValidationMethod;
  }>[];
  validationCommands: readonly string[];
  requiredEvidence: WorkflowActionV3Wire["requiredEvidence"];
  evidence: WorkflowActionV31Wire["evidence"];
  assuranceSummary:
    | WorkflowActionV32Wire["assuranceSummary"]
    | Readonly<{ state: "unavailable"; reasonCode: "not_in_protocol" }>;
  policy: Readonly<{
    status: WorkflowActionV3Wire["policy"]["status"];
    appliedOverrides: WorkflowActionV3Wire["policy"]["appliedOverrides"];
  }>;
  structuredFindings: NormalizedDeclaredValue<readonly WorkflowActionV3Wire["findings"][number][]>;
  findingMessages: readonly string[];
  verdict: WorkflowActionWire["verdict"];
  nextCommand: string;
  wire: WorkflowActionWire;
}>;

export type WorkflowActionAdapterReasonCode =
  | "workflow_action_semantics_invalid"
  | "workflow_action_identity_invalid"
  | "workflow_action_contradiction";

export type WorkflowActionAdapterResult =
  | { ok: true; value: NormalizedWorkflowAction }
  | { ok: false; reasonCode: WorkflowActionAdapterReasonCode; reason: string };

const v2ReadRoles: Readonly<Record<string, ReadRole>> = Object.freeze({
  policy: "policy",
  intent: "intent",
  specification: "specification",
  plan: "plan",
  "task-graph": "task_graph",
  "context-pack": "context_pack",
  "implementation-prompt": "implementation_prompt",
  "oracle-plan": "oracle_plan"
});
const readRoleOrder: Readonly<Record<ReadRole, number>> = Object.freeze({
  policy: 0,
  intent: 1,
  specification: 2,
  plan: 3,
  task_graph: 4,
  context_pack: 5,
  implementation_prompt: 6,
  oracle_plan: 7
});
const validationMethods = new Set<ValidationMethod>([
  "unit",
  "integration",
  "e2e",
  "manual",
  "static"
]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const bareSha256Pattern = /^[a-f0-9]{64}$/u;
const identityDomainV1 = "visp.workflow-action\0canonical-1.0\0";
const identityDomainV1_1 = "visp.workflow-action\0canonical-1.1\0";
const identityDomainV1_2 = "visp.workflow-action\0canonical-1.2\0";
const identityDomainV1_3 = "visp.workflow-action\0canonical-1.3\0";

export function normalizeWorkflowAction(
  action: WorkflowActionWire,
  selection: WorkflowActionProtocolSelection
): WorkflowActionAdapterResult {
  if (
    !isWorkflowActionProtocolSelection(selection) ||
    action.protocolVersion !== selection.protocolVersion
  ) {
    return adapterFailure(
      "workflow_action_semantics_invalid",
      `WorkflowAction ${action.protocolVersion} cannot use incoherent protocol selection provenance.`
    );
  }
  return action.protocolVersion === "2.0"
    ? normalizeWorkflowActionV2(action, selection)
    : normalizeCanonicalWorkflowAction(action, selection);
}

export function createWorkflowActionV3Id(action: unknown): `sha256:${string}` {
  const parsed = workflowActionV3StrictSchema.parse(action);
  return createCanonicalWorkflowActionId(parsed, identityDomainV1);
}

export function createWorkflowActionV31Id(action: unknown): `sha256:${string}` {
  const parsed = workflowActionV31StrictSchema.parse(action);
  return createCanonicalWorkflowActionId(parsed, identityDomainV1_1);
}

export function createWorkflowActionV32Id(action: unknown): `sha256:${string}` {
  const parsed = workflowActionV32StrictSchema.parse(action);
  return createCanonicalWorkflowActionId(parsed, identityDomainV1_2);
}

/**
 * 3.4 identity hashes a canonical-1.3 projection (D-119): `nextCommand`,
 * `assuranceSummary` and per-finding wording (message/recommendation/evidence)
 * are excluded, so command renames can never move an identity. Hyper mirrors
 * Kit's projection independently — it verifies, it does not trust.
 */
export function createWorkflowActionV34Id(action: unknown): `sha256:${string}` {
  const parsed = workflowActionV34StrictSchema.parse(action);
  const {
    protocolVersion: _protocolVersion,
    actionId: _actionId,
    nextCommand: _nextCommand,
    assuranceSummary: _assuranceSummary,
    findings,
    ...identityInput
  } = parsed;
  const projected = {
    ...identityInput,
    findings: findings.map((finding) => ({
      code: finding.code,
      source: finding.source,
      severity: finding.severity,
      effect: finding.effect
    }))
  };
  return `sha256:${createHash("sha256")
    .update(identityDomainV1_3, "utf8")
    .update(canonicalJsonV1(projected), "utf8")
    .digest("hex")}`;
}

function normalizeWorkflowActionV2(
  action: WorkflowActionV2Wire,
  selection: WorkflowActionProtocolSelection
): WorkflowActionAdapterResult {
  if (action.assuranceLevel === "local_checked") {
    return semanticFailure("Configured Kit cannot author local_checked assurance.");
  }
  if (!nonEmpty(action.goal) || !nonEmpty(action.nextCommand)) {
    return semanticFailure("V2 goal and nextCommand must be nonempty.");
  }
  if (action.taskId !== null && !idPattern.test(action.taskId)) {
    return semanticFailure("V2 taskId is invalid.");
  }
  if (
    action.validationCommands.some((command) => !nonEmpty(command)) ||
    action.findings.some((finding) => !nonEmpty(finding))
  ) {
    return semanticFailure("V2 commands and findings must be nonempty when present.");
  }

  const writablePaths = normalizePathSet(action.writablePaths);
  const forbiddenPaths = normalizePathSet(action.forbiddenPaths);
  if (!writablePaths.ok || !forbiddenPaths.ok) {
    return semanticFailure("V2 scope contains an unsafe project path.");
  }

  const requiredReads: Array<NormalizedWorkflowAction["requiredReads"][number]> = [];
  for (const read of action.requiredReads) {
    const path = normalizeProjectPath(read.path);
    const role = v2ReadRoles[read.role];
    if (path === undefined || role === undefined || !bareSha256Pattern.test(read.sha256)) {
      return semanticFailure("V2 required read cannot be normalized safely.");
    }
    requiredReads.push({
      id: unavailable(),
      role,
      path,
      contentHash: `sha256:${read.sha256}`,
      freshness: unavailable()
    });
  }
  requiredReads.sort((left, right) => {
    const roleDifference = readRoleOrder[left.role] - readRoleOrder[right.role];
    if (roleDifference !== 0) return roleDifference;
    return compareCodeUnits(left.path, right.path);
  });

  const seenOracleIds = new Set<string>();
  const validationOracles: Array<NormalizedWorkflowAction["validationOracles"][number]> = [];
  for (const oracle of action.acceptanceOracles) {
    if (
      !idPattern.test(oracle.id) ||
      seenOracleIds.has(oracle.id) ||
      !nonEmpty(oracle.expectedBehavior) ||
      !validationMethods.has(oracle.validation as ValidationMethod)
    ) {
      return semanticFailure("V2 acceptance oracle cannot be normalized safely.");
    }
    seenOracleIds.add(oracle.id);
    validationOracles.push({
      id: oracle.id,
      claimId: unavailable(),
      statement: oracle.expectedBehavior,
      testable: unavailable(),
      validationMethod: oracle.validation as ValidationMethod
    });
  }
  validationOracles.sort((left, right) => compareCodeUnits(left.id, right.id));

  const normalized: NormalizedWorkflowAction = {
    normalizationVersion: "1.0",
    source: normalizedSource(action.protocolVersion, selection),
    sourceCanonicalVersion: unavailable(),
    actionId: unavailable(),
    phase: unavailable(),
    sourcePhase: action.phase,
    feature: unavailable(),
    task:
      action.taskId === null
        ? null
        : {
            id: action.taskId,
            title: unavailable(),
            status: unavailable(),
            dependsOn: unavailable(),
            parallelizable: unavailable()
          },
    taskClass: unavailable(),
    risk: { level: unavailable(), factors: unavailable() },
    assurance: {
      level: action.assuranceLevel,
      profile: unavailable(),
      workflowStrictness: unavailable()
    },
    goal: action.goal,
    baseCommit: unavailable(),
    requiredReads,
    scope: {
      writablePaths: writablePaths.value,
      expectedPaths: unavailable(),
      forbiddenPaths: forbiddenPaths.value,
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles,
    validationCommands: [...action.validationCommands],
    requiredEvidence: unavailable(),
    evidence: unavailable(),
    assuranceSummary: unavailableInProtocol(),
    policy: { status: unavailable(), appliedOverrides: unavailable() },
    structuredFindings: unavailable(),
    findingMessages: [...action.findings],
    verdict: action.verdict,
    nextCommand: action.nextCommand,
    wire: action
  };
  return { ok: true, value: deepFreeze(normalized) };
}

function normalizeCanonicalWorkflowAction(
  action: WorkflowActionV3Wire | WorkflowActionV31Wire | WorkflowActionV32Wire | WorkflowActionV34Wire,
  selection: WorkflowActionProtocolSelection
): WorkflowActionAdapterResult {
  const expectedActionId =
    action.protocolVersion === "3.0"
      ? createWorkflowActionV3Id(action)
      : action.protocolVersion === "3.1"
        ? createWorkflowActionV31Id(action)
        : action.protocolVersion === "3.2"
          ? createWorkflowActionV32Id(action)
          : createWorkflowActionV34Id(action);
  if (expectedActionId !== action.actionId) {
    return adapterFailure(
      "workflow_action_identity_invalid",
      `WorkflowAction ${action.protocolVersion} actionId does not match its canonical body.`
    );
  }
  const effects = new Set(action.findings.map((finding) => finding.effect));
  const verdictCoherent =
    (action.verdict === "ready" && !effects.has("blocks") && !effects.has("uncertain")) ||
    (action.verdict === "blocked" && effects.has("blocks")) ||
    (action.verdict === "inconclusive" && !effects.has("blocks") && effects.has("uncertain"));
  if (!verdictCoherent) {
    return adapterFailure(
      "workflow_action_contradiction",
      `WorkflowAction ${action.protocolVersion} verdict ${action.verdict} contradicts structured finding effects.`
    );
  }
  if (
    !unique(action.requiredReads.map((read) => read.id)) ||
    !unique(action.validationOracles.map((oracle) => oracle.id))
  ) {
    return semanticFailure(
      `WorkflowAction ${action.protocolVersion} contains duplicate stable IDs.`
    );
  }

  const normalized: NormalizedWorkflowAction = {
    normalizationVersion: "1.0",
    source: normalizedSource(action.protocolVersion, selection),
    sourceCanonicalVersion: available(action.canonicalVersion),
    actionId: available(action.actionId),
    phase: available(action.phase),
    sourcePhase: action.phase,
    feature: available(action.feature),
    task:
      action.task === null
        ? null
        : {
            id: action.task.id,
            title: available(action.task.title),
            status: available(action.task.status),
            dependsOn: available([...action.task.dependsOn]),
            parallelizable: available(action.task.parallelizable)
          },
    taskClass: action.taskClass,
    risk: action.risk,
    assurance: action.assurance,
    goal: action.goal,
    baseCommit: action.baseCommit,
    requiredReads: action.requiredReads.map((read) => ({
      id: available(read.id),
      role: read.role,
      path: read.path,
      contentHash: read.contentHash as `sha256:${string}`,
      freshness: available(read.freshness)
    })),
    scope: {
      writablePaths: [...action.scope.writablePaths],
      expectedPaths: action.scope.expectedPaths,
      forbiddenPaths: [...action.scope.forbiddenPaths],
      operationLimits: action.scope.operationLimits
    },
    claims: action.claims,
    validationOracles: action.validationOracles.map((oracle) => ({
      id: oracle.id,
      claimId: available(oracle.claimId),
      statement: oracle.statement,
      testable: available(oracle.testable),
      validationMethod: oracle.validationMethod
    })),
    validationCommands: [...action.validationCommands],
    requiredEvidence: action.requiredEvidence,
    evidence: action.protocolVersion === "3.0" ? unavailable() : action.evidence,
    assuranceSummary:
      action.protocolVersion === "3.2" ? action.assuranceSummary : unavailableInProtocol(),
    policy: action.policy,
    structuredFindings: available([...action.findings]),
    findingMessages: action.findings.map((finding) => finding.message),
    verdict: action.verdict,
    nextCommand: action.nextCommand,
    wire: action
  };
  return { ok: true, value: deepFreeze(normalized) };
}

function createCanonicalWorkflowActionId(
  action: WorkflowActionV3Wire | WorkflowActionV31Wire | WorkflowActionV32Wire,
  identityDomain: string
): `sha256:${string}` {
  const { protocolVersion: _protocolVersion, actionId: _actionId, ...identityInput } = action;
  return `sha256:${createHash("sha256")
    .update(identityDomain, "utf8")
    .update(canonicalJsonV1(identityInput), "utf8")
    .digest("hex")}`;
}

function normalizedSource(
  protocolVersion: WorkflowActionWire["protocolVersion"],
  selection: WorkflowActionProtocolSelection
): NormalizedWorkflowAction["source"] {
  return {
    protocolVersion,
    selectionMode: selection.mode,
    localSchemaHash: selection.localSchemaHash,
    schemaHashVerification: selection.schemaHashVerification
  };
}

function normalizePathSet(
  paths: readonly string[]
): { ok: true; value: string[] } | { ok: false } {
  const normalized: string[] = [];
  for (const value of paths) {
    const path = normalizeProjectPath(value);
    if (path === undefined) return { ok: false };
    normalized.push(path);
  }
  return { ok: true, value: [...new Set(normalized)].sort(compareCodeUnits) };
}

function normalizeProjectPath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    return undefined;
  }
  const compact = segments.filter((segment) => segment.length > 0).join("/");
  return compact.length > 0 ? compact : undefined;
}

function canonicalJsonV1(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical-json-v1 rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("canonical-json-v1 rejects cycles");
    ancestors.add(value);
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("canonical-json-v1 rejects sparse arrays");
      entries.push(canonicalJsonV1(value[index], ancestors));
    }
    ancestors.delete(value);
    return `[${entries.join(",")}]`;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) throw new TypeError("canonical-json-v1 rejects cycles");
    ancestors.add(value);
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonV1(object[key], ancestors)}`);
    ancestors.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonical-json-v1 rejects ${typeof value}`);
}

function available<T>(value: T): NormalizedDeclaredValue<T> {
  return { state: "available", value: value as DeepReadonly<T> };
}

function unavailable<T>(): NormalizedDeclaredValue<T> {
  return { state: "unavailable", reasonCode: "not_in_protocol" };
}

function unavailableInProtocol(): Readonly<{
  state: "unavailable";
  reasonCode: "not_in_protocol";
}> {
  return { state: "unavailable", reasonCode: "not_in_protocol" };
}

function nonEmpty(value: string): boolean {
  return value.length > 0;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function semanticFailure(reason: string): WorkflowActionAdapterResult {
  return adapterFailure("workflow_action_semantics_invalid", reason);
}

function adapterFailure(
  reasonCode: WorkflowActionAdapterReasonCode,
  reason: string
): WorkflowActionAdapterResult {
  return { ok: false, reasonCode, reason };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
