import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  COCKPIT_API_VERSION,
  COCKPIT_MEMORY_ARTIFACT_PATHS,
  cockpitArtifactPath,
  type CockpitArtifactCommand,
  type CockpitArtifactPath,
  type CockpitArtifactValue,
  type CockpitArtifactView,
  type CockpitCommandPalette,
  type CockpitScreen,
  type CockpitStateV1,
  type NonEmptyReadonlyArray
} from "./contracts.js";

export type CockpitKitReadOptions = Readonly<{
  artifactName?: string;
  staleAfter?: Date;
}>;

export type CockpitKitReadState<T = unknown> =
  | Readonly<{ state: "present"; path: string; modifiedAt: string; value: T }>
  | Readonly<{
      state: "stale";
      path: string;
      modifiedAt: string;
      staleAfter: string;
      reason: string;
      value: T;
    }>
  | Readonly<{ state: "missing"; path: string; reason: string }>
  | Readonly<{
      state: "unreadable";
      path: string;
      issue: "io" | "invalid_json" | "invalid_schema";
      reason: string;
    }>;

type StaticAccessor = (options?: CockpitKitReadOptions) => Promise<CockpitKitReadState>;
type FeatureAccessor = (
  featureKey: string,
  options?: CockpitKitReadOptions
) => Promise<CockpitKitReadState>;
type TaskAccessor = (
  featureKey: string,
  taskId: string,
  options?: CockpitKitReadOptions
) => Promise<CockpitKitReadState>;

export type CockpitKitArtifactReader = Readonly<{
  projectProfile: StaticAccessor;
  projectConfig: StaticAccessor;
  projectStatus: StaticAccessor;
  policy: StaticAccessor;
  workflowManifest: StaticAccessor;
  featureIntent: FeatureAccessor;
  specification: FeatureAccessor;
  plan: FeatureAccessor;
  taskGraph: FeatureAccessor;
  verification: FeatureAccessor;
  taskReview: TaskAccessor;
  assuranceCase: TaskAccessor;
  currentReviewDecision: TaskAccessor;
  reviewDecision: (
    featureKey: string,
    taskId: string,
    decisionHash: string,
    options?: CockpitKitReadOptions
  ) => Promise<CockpitKitReadState>;
  runIndex: StaticAccessor;
  constitution: StaticAccessor;
  patterns: StaticAccessor;
  projectSummary: StaticAccessor;
  doctorReport: StaticAccessor;
}>;

export type CockpitStaleAfterResolver = (
  expectedPath: CockpitArtifactPath
) => Date | undefined;

export type ReadCockpitStateOptions = Readonly<{
  projectPath: string;
  reader: CockpitKitArtifactReader;
  staleAfter?: CockpitStaleAfterResolver;
}>;

type RootState = "present" | "uninitialized" | "unavailable";
type ValueField = readonly [key: string, label: string];
type Projection = Readonly<{
  values: NonEmptyReadonlyArray<CockpitArtifactValue>;
  commands: readonly CockpitArtifactCommand[];
}>;
type ReadResult = Readonly<{
  view: CockpitArtifactView;
  commands: readonly CockpitArtifactCommand[];
  presentValue?: unknown;
}>;
type ReadContext = Readonly<{
  projectPath: string;
  rootState: RootState;
  staleAfter?: CockpitStaleAfterResolver;
}>;
type ArtifactCoordinates = Readonly<{
  featureKey?: string;
  featureId?: string;
  featureSlug?: string;
  taskId?: string;
}>;
type BoundReviewDecisionPointer = Readonly<{
  decisionHash: string;
  historyPath: CockpitArtifactPath;
  featureId: string;
  featureSlug: string;
  taskId: string;
  updatedAt: string;
}>;

const STATUS_PATH = cockpitArtifactPath(".visp/status.json");
const PROFILE_PATH = cockpitArtifactPath(".visp/project.json");
const CONFIG_PATH = cockpitArtifactPath(".visp/config.json");
const POLICY_PATH = cockpitArtifactPath(".visp/policy.json");
const WORKFLOW_PATH = cockpitArtifactPath(".visp/workflow.json");
const RUN_INDEX_PATH = cockpitArtifactPath(".visp/runs/index.json");
const DOCTOR_PATH = cockpitArtifactPath(".visp/reports/doctor-report.md");

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REVIEW_DECISION_HASH = /^sha256:([a-f0-9]{64})$/u;

export async function readCockpitState(
  options: ReadCockpitStateOptions
): Promise<CockpitStateV1> {
  const rootState = await inspectRootState(options.projectPath);
  const context: ReadContext = {
    projectPath: options.projectPath,
    rootState,
    staleAfter: options.staleAfter
  };

  const status = await readArtifact(
    context,
    STATUS_PATH,
    "project-status",
    "Project status",
    (readOptions) => options.reader.projectStatus(readOptions),
    (value, sourcePath) =>
      projectRecord(value, sourcePath, [
        ["initialized", "Initialized"],
        ["activeFeatureId", "Active feature ID"],
        ["activeFeatureSlug", "Active feature slug"],
        ["activeFeaturePath", "Active feature path"],
        ["activeTaskId", "Active task ID"],
        ["currentState", "Current state"],
        ["lastCommand", "Last command label"],
        ["updatedAt", "Updated at"]
      ])
  );
  const coordinates = coordinatesFromStatus(status.presentValue);

  const [
    profile,
    config,
    policy,
    workflow,
    runIndex,
    constitution,
    patterns,
    projectSummary,
    doctor
  ] = await Promise.all([
    readArtifact(
      context,
      PROFILE_PATH,
      "project-profile",
      "Project profile",
      (readOptions) => options.reader.projectProfile(readOptions),
      projectProfile
    ),
    readArtifact(
      context,
      CONFIG_PATH,
      "project-config",
      "Project configuration",
      (readOptions) => options.reader.projectConfig(readOptions),
      (value, sourcePath) =>
        projectRecord(value, sourcePath, [
          ["schemaVersion", "Schema version"],
          ["projectId", "Project ID"],
          ["budgetMode", "Budget mode"],
          ["preset", "Preset"],
          ["agent", "Agent mode"],
          ["updatedAt", "Updated at"]
        ])
    ),
    readArtifact(
      context,
      POLICY_PATH,
      "policy",
      "Policy",
      (readOptions) => options.reader.policy(readOptions),
      (value, sourcePath) =>
        projectRecord(value, sourcePath, [
          ["version", "Version"],
          ["strictnessMode", "Strictness mode"],
          ["rules", "Rules"],
          ["limits", "Limits"],
          ["overrides", "Overrides"],
          ["assurance", "Assurance"]
        ])
    ),
    readArtifact(
      context,
      WORKFLOW_PATH,
      "workflow",
      "Workflow manifest",
      (readOptions) => options.reader.workflowManifest(readOptions),
      projectWorkflow
    ),
    readArtifact(
      context,
      RUN_INDEX_PATH,
      "run-index",
      "Run index",
      (readOptions) => options.reader.runIndex(readOptions),
      (value, sourcePath) =>
        projectRecord(value, sourcePath, [["latestRunId", "Latest run ID"]])
    ),
    readArtifact(
      context,
      COCKPIT_MEMORY_ARTIFACT_PATHS[0],
      "constitution",
      "Constitution",
      (readOptions) => options.reader.constitution(readOptions),
      projectText
    ),
    readArtifact(
      context,
      COCKPIT_MEMORY_ARTIFACT_PATHS[1],
      "patterns",
      "Patterns",
      (readOptions) => options.reader.patterns(readOptions),
      projectText
    ),
    readArtifact(
      context,
      COCKPIT_MEMORY_ARTIFACT_PATHS[2],
      "project-summary",
      "Project summary",
      (readOptions) => options.reader.projectSummary(readOptions),
      projectText
    ),
    readArtifact(
      context,
      DOCTOR_PATH,
      "doctor-report",
      "Doctor report",
      (readOptions) => options.reader.doctorReport(readOptions),
      projectText
    )
  ]);

  const featureResults = coordinates.featureKey === undefined
    ? unresolvedFeatureResults()
    : await readFeatureArtifacts(context, options.reader, coordinates.featureKey);
  const taskResults =
    coordinates.featureKey === undefined || coordinates.taskId === undefined
      ? unresolvedTaskResults()
      : await readTaskArtifacts(
          context,
          options.reader,
          coordinates.featureKey,
          coordinates.taskId,
          coordinates.featureId,
          coordinates.featureSlug
        );

  const allResults = [
    status,
    profile,
    config,
    policy,
    workflow,
    runIndex,
    constitution,
    patterns,
    projectSummary,
    doctor,
    ...Object.values(featureResults),
    ...Object.values(taskResults)
  ];
  const commandPalette = commandPaletteFrom(allResults.flatMap((result) => result.commands));

  return Object.freeze({
    apiVersion: COCKPIT_API_VERSION,
    screens: Object.freeze({
      now: screen("now", "Now", [status.view]),
      feature: screen("feature", "Feature", [
        featureResults.intent.view,
        featureResults.specification.view,
        featureResults.plan.view,
        featureResults.taskGraph.view
      ]),
      scope: screen("scope", "Scope", [
        featureResults.taskGraph.view,
        featureResults.verification.view
      ]),
      assurance: screen("assurance", "Assurance", [
        featureResults.verification.view,
        taskResults.assuranceCase.view
      ]),
      review: screen("review", "Review", [
        taskResults.taskReview.view,
        taskResults.decisionPointer.view,
        taskResults.reviewDecision.view
      ]),
      runs: screen("runs", "Runs", [runIndex.view]),
      memory: screen("memory", "Memory", [
        constitution.view,
        patterns.view,
        projectSummary.view
      ]),
      health: screen("health", "Health", [doctor.view]),
      reference: screen("reference", "Reference", [
        profile.view,
        config.view,
        policy.view,
        workflow.view
      ])
    }),
    commandPalette
  });
}

async function readFeatureArtifacts(
  context: ReadContext,
  reader: CockpitKitArtifactReader,
  featureKey: string
) {
  const intentPath = featureArtifactPath(featureKey, "intent.json");
  const specificationPath = featureArtifactPath(featureKey, "spec.json");
  const planPath = featureArtifactPath(featureKey, "plan.json");
  const taskGraphPath = featureArtifactPath(featureKey, "task-graph.json");
  const verificationPath = featureArtifactPath(featureKey, "verification.json");
  const [intent, specification, plan, taskGraph, verification] = await Promise.all([
    readArtifact(
      context,
      intentPath,
      "feature-intent",
      "Feature intent",
      (options) => reader.featureIntent(featureKey, options),
      (value, sourcePath) =>
        projectRecord(value, sourcePath, [
          ["id", "Feature ID"],
          ["slug", "Slug"],
          ["title", "Title"],
          ["status", "Stored status"],
          ["budgetMode", "Budget mode"],
          ["riskLevel", "Risk level"],
          ["updatedAt", "Updated at"]
        ])
    ),
    readArtifact(
      context,
      specificationPath,
      "specification",
      "Specification",
      (options) => reader.specification(featureKey, options),
      projectWholeArtifact
    ),
    readArtifact(
      context,
      planPath,
      "plan",
      "Plan",
      (options) => reader.plan(featureKey, options),
      projectWholeArtifact
    ),
    readArtifact(
      context,
      taskGraphPath,
      "task-graph",
      "Task graph",
      (options) => reader.taskGraph(featureKey, options),
      projectTaskGraph
    ),
    readArtifact(
      context,
      verificationPath,
      "verification",
      "Verification report",
      (options) => reader.verification(featureKey, options),
      projectVerification
    )
  ]);
  return Object.freeze({ intent, specification, plan, taskGraph, verification });
}

async function readTaskArtifacts(
  context: ReadContext,
  reader: CockpitKitArtifactReader,
  featureKey: string,
  taskId: string,
  activeFeatureId: string | undefined,
  activeFeatureSlug: string | undefined
) {
  const taskReviewPath = cockpitArtifactPath(
    `.visp/features/${featureKey}/review/${taskId}.review.json`
  );
  const assurancePath = assuranceArtifactPath(featureKey, taskId, "assurance-case.json");
  const decisionPointerPath = assuranceArtifactPath(featureKey, taskId, "review-decision.json");
  const [taskReview, assuranceCase, decisionPointer] = await Promise.all([
    readArtifact(
      context,
      taskReviewPath,
      "task-review",
      "Task review",
      (options) => reader.taskReview(featureKey, taskId, options),
      projectReview
    ),
    readArtifact(
      context,
      assurancePath,
      "assurance-case",
      "Assurance case",
      (options) => reader.assuranceCase(featureKey, taskId, options),
      projectAssurance
    ),
    readArtifact(
      context,
      decisionPointerPath,
      "review-decision-pointer",
      "Review decision pointer",
      (options) => reader.currentReviewDecision(featureKey, taskId, options),
      (value, sourcePath) =>
        projectRecord(value, sourcePath, [
          ["decisionPath", "Decision path"],
          ["decisionHash", "Decision hash"],
          ["updatedAt", "Updated at"]
        ])
    )
  ]);

  if (decisionPointer.presentValue === undefined) {
    return Object.freeze({
      taskReview,
      assuranceCase,
      decisionPointer,
      reviewDecision: unresolvedReviewDecision(decisionPointerPath)
    });
  }

  const boundPointer = bindReviewDecisionPointer(
    decisionPointer.presentValue,
    featureKey,
    taskId,
    activeFeatureId,
    activeFeatureSlug
  );
  if (boundPointer === undefined) {
    const reason = "Review decision pointer identity does not match the active feature, task, and canonical history path.";
    return Object.freeze({
      taskReview,
      assuranceCase,
      decisionPointer: unavailableResult(
        "review-decision-pointer",
        "Review decision pointer",
        decisionPointerPath,
        reason,
        decisionPointerPath
      ),
      reviewDecision: unresolvedArtifact(
        "review-decision",
        "Review decision",
        decisionPointerPath,
        reason
      )
    });
  }

  const readDecision = await readArtifact(
    context,
    boundPointer.historyPath,
    "review-decision",
    "Review decision",
    (options) => reader.reviewDecision(featureKey, taskId, boundPointer.decisionHash, options),
    (value, sourcePath) =>
      projectRecord(value, sourcePath, [
        ["reviewerId", "Reviewer ID"],
        ["identityAssurance", "Identity assurance"],
        ["decision", "Stored decision"],
        ["reason", "Reason"],
        ["decidedAt", "Decided at"],
        ["decisionHash", "Decision hash"]
      ])
  );
  const reviewDecision =
    readDecision.presentValue === undefined ||
    reviewDecisionMatchesPointer(readDecision.presentValue, boundPointer)
      ? readDecision
      : unavailableResult(
          "review-decision",
          "Review decision",
          boundPointer.historyPath,
          "Review decision history identity does not match its pointer and active coordinates.",
          boundPointer.historyPath
        );

  return Object.freeze({ taskReview, assuranceCase, decisionPointer, reviewDecision });
}

function unresolvedReviewDecision(pointerPath: CockpitArtifactPath): ReadResult {
  return unresolvedArtifact(
    "review-decision",
    "Review decision",
    pointerPath,
    "A validated current review-decision pointer is required to resolve decision history."
  );
}

function bindReviewDecisionPointer(
  value: unknown,
  featureKey: string,
  taskId: string,
  activeFeatureId: string | undefined,
  activeFeatureSlug: string | undefined
): BoundReviewDecisionPointer | undefined {
  if (activeFeatureId === undefined || activeFeatureSlug === undefined) return undefined;

  const decisionHash = recordString(value, "decisionHash");
  if (decisionHash === undefined) return undefined;
  const digest = REVIEW_DECISION_HASH.exec(decisionHash)?.[1];
  if (digest === undefined) return undefined;

  const historyPath = assuranceArtifactPath(
    featureKey,
    taskId,
    `review-decisions/${digest}.json`
  );
  const featureId = recordString(value, "featureId");
  const featureSlug = recordString(value, "featureSlug");
  const pointerTaskId = recordString(value, "taskId");
  const decisionPath = recordString(value, "decisionPath");
  const updatedAt = recordString(value, "updatedAt");
  if (
    featureId !== activeFeatureId ||
    featureSlug !== activeFeatureSlug ||
    pointerTaskId !== taskId ||
    decisionPath !== historyPath ||
    updatedAt === undefined
  ) {
    return undefined;
  }

  return Object.freeze({
    decisionHash,
    historyPath,
    featureId,
    featureSlug,
    taskId: pointerTaskId,
    updatedAt
  });
}

function reviewDecisionMatchesPointer(
  value: unknown,
  pointer: BoundReviewDecisionPointer
): boolean {
  return (
    recordString(value, "decisionHash") === pointer.decisionHash &&
    recordString(value, "featureId") === pointer.featureId &&
    recordString(value, "featureSlug") === pointer.featureSlug &&
    recordString(value, "taskId") === pointer.taskId &&
    recordString(value, "decidedAt") === pointer.updatedAt
  );
}

async function readArtifact(
  context: ReadContext,
  expectedPath: CockpitArtifactPath,
  id: string,
  label: string,
  read: (options?: CockpitKitReadOptions) => Promise<CockpitKitReadState>,
  project: (value: unknown, sourcePath: CockpitArtifactPath) => Projection
): Promise<ReadResult> {
  let state: unknown;
  try {
    const staleAfter = context.staleAfter?.(expectedPath);
    state = await read(staleAfter === undefined ? undefined : Object.freeze({ staleAfter }));
  } catch {
    return unavailableResult(id, label, expectedPath, "Kit could not read this artifact.");
  }

  if (!isKitReadState(state) || !matchesExpectedPath(context.projectPath, state.path, expectedPath)) {
    return unavailableResult(
      id,
      label,
      expectedPath,
      "Kit returned an unsupported artifact state or mismatched provenance."
    );
  }

  if (state.state === "missing") {
    if (context.rootState === "uninitialized") {
      return Object.freeze({
        view: Object.freeze({
          id,
          label,
          state: "uninitialized" as const,
          reason: "The repository has no .visp artifact root.",
          expectedPath
        }),
        commands: Object.freeze([])
      });
    }
    if (context.rootState === "unavailable") {
      return unavailableResult(
        id,
        label,
        expectedPath,
        "The .visp artifact root is not a readable directory."
      );
    }
    return Object.freeze({
      view: Object.freeze({
        id,
        label,
        state: "missing" as const,
        reason: sanitizeReason(state.reason, state.path, expectedPath),
        expectedPath
      }),
      commands: Object.freeze([])
    });
  }

  if (state.state === "stale") {
    return Object.freeze({
      view: Object.freeze({
        id,
        label,
        state: "stale" as const,
        reason: sanitizeReason(state.reason, state.path, expectedPath),
        expectedPath,
        sourcePath: expectedPath
      }),
      commands: Object.freeze([])
    });
  }

  if (state.state === "unreadable") {
    const corrupt = state.issue === "invalid_json" || state.issue === "invalid_schema";
    return Object.freeze({
      view: Object.freeze({
        id,
        label,
        state: corrupt ? ("corrupt" as const) : ("unavailable" as const),
        reason: sanitizeReason(state.reason, state.path, expectedPath),
        expectedPath,
        sourcePath: expectedPath
      }),
      commands: Object.freeze([])
    });
  }

  try {
    const projection = project(state.value, expectedPath);
    return Object.freeze({
      view: Object.freeze({
        id,
        label,
        state: "present" as const,
        sourcePath: expectedPath,
        values: projection.values
      }),
      commands: projection.commands,
      presentValue: state.value
    });
  } catch {
    return unavailableResult(
      id,
      label,
      expectedPath,
      "Kit returned a validated artifact shape this Cockpit version cannot present.",
      expectedPath
    );
  }
}

function projectRecord(
  value: unknown,
  sourcePath: CockpitArtifactPath,
  fields: readonly ValueField[],
  commands: readonly CockpitArtifactCommand[] = []
): Projection {
  const record = asRecord(value);
  const values = fields.flatMap(([key, label]) => {
    if (!(key in record) || record[key] === undefined) return [];
    return [artifactValue(label, scalarFrom(record[key]), sourcePath)];
  });
  if (values.length === 0) throw new TypeError("Artifact projection contains no display values.");
  return Object.freeze({
    values: Object.freeze(values) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([...commands])
  });
}

function projectWholeArtifact(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  return Object.freeze({
    values: Object.freeze([
      artifactValue("Artifact", scalarFrom(value), sourcePath)
    ]) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([])
  });
}

function projectText(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Text artifact projection requires nonempty text.");
  }
  return Object.freeze({
    values: Object.freeze([
      artifactValue("Content", value, sourcePath)
    ]) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([])
  });
}

function projectProfile(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  return projectRecord(
    value,
    sourcePath,
    [
      ["name", "Name"],
      ["packageManager", "Package manager"],
      ["languages", "Languages"],
      ["frameworks", "Frameworks"],
      ["testFrameworks", "Test frameworks"],
      ["sourceRoots", "Source roots"],
      ["testRoots", "Test roots"]
    ],
    commandArrays(record, sourcePath, [
      ["buildCommands", "Build command"],
      ["testCommands", "Test command"],
      ["lintCommands", "Lint command"],
      ["typecheckCommands", "Typecheck command"]
    ])
  );
}

function projectWorkflow(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  if (Array.isArray(record.stages)) {
    for (const stage of record.stages) {
      if (!isRecord(stage)) continue;
      const name = typeof stage.name === "string" ? stage.name : "Workflow stage";
      pushCommand(commands, `${name} command`, stage.command, sourcePath);
      pushCommand(commands, `${name} next command`, stage.nextCommand, sourcePath);
    }
  }
  return projectRecord(
    value,
    sourcePath,
    [
      ["version", "Version"],
      ["generatedAt", "Generated at"],
      ["stages", "Stages"],
      ["principles", "Principles"]
    ],
    commands
  );
}

function projectTaskGraph(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  if (Array.isArray(record.tasks)) {
    for (const task of record.tasks) {
      if (!isRecord(task) || !Array.isArray(task.validationCommands)) continue;
      const taskId = typeof task.id === "string" ? task.id : "Task";
      for (const command of task.validationCommands) {
        pushCommand(commands, `${taskId} validation command`, command, sourcePath);
      }
    }
  }
  return projectRecord(
    value,
    sourcePath,
    [
      ["featureId", "Feature ID"],
      ["featureSlug", "Feature slug"],
      ["status", "Stored status"],
      ["tasks", "Tasks"],
      ["updatedAt", "Updated at"]
    ],
    commands
  );
}

function projectVerification(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Verification next command", record.nextCommand, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["id", "Report ID"],
      ["taskId", "Task ID"],
      ["mode", "Mode"],
      ["success", "Stored success"],
      ["summary", "Summary"],
      ["scopeValidation", "Scope validation"],
      ["warnings", "Warnings"],
      ["errors", "Errors"],
      ["nextCommand", "Next command"]
    ],
    commands
  );
}

function projectReview(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Review next command", record.nextCommand, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["id", "Report ID"],
      ["taskId", "Task ID"],
      ["mode", "Mode"],
      ["success", "Stored success"],
      ["result", "Stored result"],
      ["findings", "Findings"],
      ["warnings", "Warnings"],
      ["errors", "Errors"],
      ["nextCommand", "Next command"]
    ],
    commands
  );
}

function projectAssurance(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const nextAction = isRecord(record.nextAction) ? record.nextAction : undefined;
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Assurance next action", nextAction?.command, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["taskId", "Task ID"],
      ["assuranceProfile", "Assurance profile"],
      ["claims", "Claims"],
      ["unresolvedItems", "Unresolved items"],
      ["verdict", "Stored verdict"],
      ["nextAction", "Next action"],
      ["caseHash", "Case hash"]
    ],
    commands
  );
}

function unresolvedFeatureResults() {
  return Object.freeze({
    intent: unresolvedFromStatus("feature-intent", "Feature intent"),
    specification: unresolvedFromStatus("specification", "Specification"),
    plan: unresolvedFromStatus("plan", "Plan"),
    taskGraph: unresolvedFromStatus("task-graph", "Task graph"),
    verification: unresolvedFromStatus("verification", "Verification report")
  });
}

function unresolvedTaskResults() {
  return Object.freeze({
    taskReview: unresolvedFromStatus("task-review", "Task review"),
    assuranceCase: unresolvedFromStatus("assurance-case", "Assurance case"),
    decisionPointer: unresolvedFromStatus(
      "review-decision-pointer",
      "Review decision pointer"
    ),
    reviewDecision: unresolvedFromStatus("review-decision", "Review decision")
  });
}

function unresolvedFromStatus(id: string, label: string): ReadResult {
  return unresolvedArtifact(
    id,
    label,
    STATUS_PATH,
    "A validated active feature and task in project status are required to resolve this artifact."
  );
}

function unresolvedArtifact(
  id: string,
  label: string,
  expectedPath: CockpitArtifactPath,
  reason: string
): ReadResult {
  return Object.freeze({
    view: Object.freeze({
      id,
      label,
      state: "unavailable" as const,
      reason,
      expectedPath
    }),
    commands: Object.freeze([])
  });
}

function unavailableResult(
  id: string,
  label: string,
  expectedPath: CockpitArtifactPath,
  reason: string,
  sourcePath?: CockpitArtifactPath
): ReadResult {
  return Object.freeze({
    view: Object.freeze({
      id,
      label,
      state: "unavailable" as const,
      reason,
      expectedPath,
      ...(sourcePath === undefined ? {} : { sourcePath })
    }),
    commands: Object.freeze([])
  });
}

function coordinatesFromStatus(value: unknown): ArtifactCoordinates {
  if (!isRecord(value)) return Object.freeze({});
  const featurePath = value.activeFeaturePath;
  const match = typeof featurePath === "string"
    ? /^\.visp\/features\/([^/]+)$/u.exec(featurePath)
    : null;
  const featureKey = match?.[1];
  if (featureKey === undefined || !isSafeSegment(featureKey)) return Object.freeze({});
  const featureId = typeof value.activeFeatureId === "string"
    ? value.activeFeatureId
    : undefined;
  const featureSlug = typeof value.activeFeatureSlug === "string"
    ? value.activeFeatureSlug
    : undefined;
  const taskId = typeof value.activeTaskId === "string" && isSafeSegment(value.activeTaskId)
    ? value.activeTaskId
    : undefined;
  return Object.freeze({
    featureKey,
    ...(featureId === undefined ? {} : { featureId }),
    ...(featureSlug === undefined ? {} : { featureSlug }),
    ...(taskId === undefined ? {} : { taskId })
  });
}

function featureArtifactPath(featureKey: string, filename: string): CockpitArtifactPath {
  return cockpitArtifactPath(`.visp/features/${featureKey}/${filename}`);
}

function assuranceArtifactPath(
  featureKey: string,
  taskId: string,
  suffix: string
): CockpitArtifactPath {
  return cockpitArtifactPath(`.visp/features/${featureKey}/assurance/${taskId}/${suffix}`);
}

function screen<Id extends CockpitScreen["id"]>(
  id: Id,
  label: CockpitScreen<Id>["label"],
  artifacts: readonly CockpitArtifactView[]
): CockpitScreen<Id> {
  if (artifacts.length === 0) throw new TypeError("Cockpit screens require an artifact view.");
  return Object.freeze({
    id,
    label,
    artifacts: Object.freeze([...artifacts]) as CockpitScreen<Id>["artifacts"]
  });
}

function commandPaletteFrom(commands: readonly CockpitArtifactCommand[]): CockpitCommandPalette {
  const seen = new Set<string>();
  const unique = commands.filter((entry) => {
    const key = `${entry.sourcePath}\u0000${entry.command}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) {
    return Object.freeze({
      state: "unavailable",
      reason: "No present artifact supplies a command to copy.",
      expectedPath: WORKFLOW_PATH
    });
  }
  return Object.freeze({
    state: "present",
    sourcePath: unique[0]!.sourcePath,
    commands: Object.freeze(unique) as NonEmptyReadonlyArray<CockpitArtifactCommand>
  });
}

function commandArrays(
  record: Record<string, unknown>,
  sourcePath: CockpitArtifactPath,
  fields: readonly ValueField[]
): readonly CockpitArtifactCommand[] {
  const commands: CockpitArtifactCommand[] = [];
  for (const [key, label] of fields) {
    if (!Array.isArray(record[key])) continue;
    for (const command of record[key]) pushCommand(commands, label, command, sourcePath);
  }
  return commands;
}

function pushCommand(
  commands: CockpitArtifactCommand[],
  label: string,
  command: unknown,
  sourcePath: CockpitArtifactPath
): void {
  if (typeof command !== "string" || command.trim().length === 0) return;
  commands.push(Object.freeze({ label, command, sourcePath }));
}

function artifactValue(
  label: string,
  value: CockpitArtifactValue["value"],
  sourcePath: CockpitArtifactPath
): CockpitArtifactValue {
  return Object.freeze({ label, value, sourcePath });
}

function scalarFrom(value: unknown): CockpitArtifactValue["value"] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Artifact value cannot be represented.");
  return serialized;
}

function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Artifact value must be an object.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

function isKitReadState(value: unknown): value is CockpitKitReadState {
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.path !== "string") {
    return false;
  }
  if (value.state === "present") return "value" in value;
  if (value.state === "stale") {
    return "value" in value && typeof value.reason === "string";
  }
  if (value.state === "missing") return typeof value.reason === "string";
  return (
    value.state === "unreadable" &&
    (value.issue === "io" || value.issue === "invalid_json" || value.issue === "invalid_schema") &&
    typeof value.reason === "string"
  );
}

function matchesExpectedPath(
  projectPath: string,
  actualPath: string,
  expectedPath: CockpitArtifactPath
): boolean {
  return resolve(actualPath) === resolve(projectPath, expectedPath);
}

function sanitizeReason(
  reason: string,
  absolutePath: string,
  expectedPath: CockpitArtifactPath
): string {
  const sanitized = reason.split(absolutePath).join(expectedPath).trim();
  return sanitized.length === 0 ? `Artifact state is degraded at ${expectedPath}.` : sanitized;
}

async function inspectRootState(projectPath: string): Promise<RootState> {
  try {
    const info = await lstat(resolve(projectPath, ".visp"));
    return info.isDirectory() && !info.isSymbolicLink() ? "present" : "unavailable";
  } catch (error) {
    return isNodeError(error, "ENOENT") ? "uninitialized" : "unavailable";
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
