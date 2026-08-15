/**
 * The Cockpit read model: the Kit artifact-reader contract this module set
 * consumes, the internal shapes a read passes around, and the fixed artifact
 * paths it may look at.
 *
 * The paths are a closed list on purpose. The Cockpit reads named artifacts
 * below .visp/ and nothing else, so the set of things it can be pointed at is
 * decided here rather than assembled from a request.
 */

import { cockpitArtifactPath } from "../contracts.js";
import type { CockpitArtifactCommand, CockpitArtifactPath, CockpitArtifactValue, CockpitArtifactView, NonEmptyReadonlyArray } from "../contracts.js";
import { projectProfile } from "./projections.js";

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

export type StaticAccessor = (options?: CockpitKitReadOptions) => Promise<CockpitKitReadState>;
export type FeatureAccessor = (
  featureKey: string,
  options?: CockpitKitReadOptions
) => Promise<CockpitKitReadState>;
export type TaskAccessor = (
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

export type RootState = "present" | "uninitialized" | "unavailable";
export type ValueField = readonly [key: string, label: string];
export type Projection = Readonly<{
  values: NonEmptyReadonlyArray<CockpitArtifactValue>;
  commands: readonly CockpitArtifactCommand[];
}>;
export type ReadResult = Readonly<{
  view: CockpitArtifactView;
  commands: readonly CockpitArtifactCommand[];
  presentValue?: unknown;
}>;
export type ReadContext = Readonly<{
  projectPath: string;
  rootState: RootState;
  staleAfter?: CockpitStaleAfterResolver;
}>;
export type ArtifactCoordinates = Readonly<{
  featureKey?: string;
  featureId?: string;
  featureSlug?: string;
  taskId?: string;
}>;
export type BoundReviewDecisionPointer = Readonly<{
  decisionHash: string;
  historyPath: CockpitArtifactPath;
  featureId: string;
  featureSlug: string;
  taskId: string;
  updatedAt: string;
}>;

// Annotated rather than inferred: `CockpitArtifactPath` is branded, and the
// brand symbol is private to contracts.ts. Inference would reach for that
// symbol by name and fail declaration emit — naming the exported alias instead
// says the same thing and stays emittable.
export const STATUS_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/status.json");
export const PROFILE_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/project.json");
export const CONFIG_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/config.json");
export const POLICY_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/policy.json");
export const WORKFLOW_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/workflow.json");
export const RUN_INDEX_PATH: CockpitArtifactPath = cockpitArtifactPath(".visp/runs/index.json");
export const DOCTOR_PATH: CockpitArtifactPath = cockpitArtifactPath(
  ".visp/reports/doctor-report.md"
);

export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const REVIEW_DECISION_HASH = /^sha256:([a-f0-9]{64})$/u;
