/**
 * Reading the Cockpit's state from the artifacts on disk.
 *
 * This file owns the traversal: which artifacts each screen needs, in what
 * order, and how a failure on one of them degrades that screen without taking
 * the rest of the page with it. The read model, the projections, and the
 * result shapes live beside it in `./artifact-state/`.
 */

import { COCKPIT_API_VERSION, COCKPIT_MEMORY_ARTIFACT_PATHS, cockpitArtifactPath } from "./contracts.js";
import type { CockpitArtifactPath, CockpitStateV1 } from "./contracts.js";
import { CONFIG_PATH, DOCTOR_PATH, POLICY_PATH, PROFILE_PATH, RUN_INDEX_PATH, STATUS_PATH, WORKFLOW_PATH } from "./artifact-state/types.js";
import { projectAssurance, projectProfile, projectRecord, projectReview, projectTaskGraph, projectText, projectVerification, projectWholeArtifact, projectWorkflow } from "./artifact-state/projections.js";
import { bindReviewDecisionPointer, reviewDecisionMatchesPointer, unresolvedReviewDecision } from "./artifact-state/review-decision.js";
import { assuranceArtifactPath, commandPaletteFrom, coordinatesFromStatus, featureArtifactPath, inspectRootState, isKitReadState, matchesExpectedPath, sanitizeReason, screen, unavailableResult, unresolvedArtifact, unresolvedFeatureResults, unresolvedTaskResults } from "./artifact-state/results.js";
import type { CockpitKitArtifactReader, CockpitKitReadOptions, CockpitKitReadState, Projection, ReadCockpitStateOptions, ReadContext, ReadResult } from "./artifact-state/types.js";

export type {
  CockpitKitArtifactReader,
  CockpitKitReadOptions,
  CockpitKitReadState,
  CockpitStaleAfterResolver,
  ReadCockpitStateOptions
} from "./artifact-state/types.js";

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
