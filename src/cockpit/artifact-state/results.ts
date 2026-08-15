/**
 * Assembling what a read reports — including when it has nothing to report.
 *
 * A missing, stale, or unreadable artifact still produces a result naming the
 * path it expected, because a screen that renders empty is indistinguishable
 * from a screen that failed.
 */

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { cockpitArtifactPath } from "../contracts.js";
import type { CockpitArtifactCommand, CockpitArtifactPath, CockpitArtifactView, CockpitCommandPalette, CockpitScreen, NonEmptyReadonlyArray } from "../contracts.js";
import { isNodeError, isRecord } from "../../core/guards.js";
import { SAFE_SEGMENT, STATUS_PATH, WORKFLOW_PATH } from "./types.js";
import type { ArtifactCoordinates, CockpitKitReadState, ReadResult, RootState } from "./types.js";

export function unresolvedFeatureResults() {
  return Object.freeze({
    intent: unresolvedFromStatus("feature-intent", "Feature intent"),
    specification: unresolvedFromStatus("specification", "Specification"),
    plan: unresolvedFromStatus("plan", "Plan"),
    taskGraph: unresolvedFromStatus("task-graph", "Task graph"),
    verification: unresolvedFromStatus("verification", "Verification report")
  });
}

export function unresolvedTaskResults() {
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

export function unresolvedFromStatus(id: string, label: string): ReadResult {
  return unresolvedArtifact(
    id,
    label,
    STATUS_PATH,
    "A validated active feature and task in project status are required to resolve this artifact."
  );
}

export function unresolvedArtifact(
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

export function unavailableResult(
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

export function coordinatesFromStatus(value: unknown): ArtifactCoordinates {
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

export function featureArtifactPath(featureKey: string, filename: string): CockpitArtifactPath {
  return cockpitArtifactPath(`.visp/features/${featureKey}/${filename}`);
}

export function assuranceArtifactPath(
  featureKey: string,
  taskId: string,
  suffix: string
): CockpitArtifactPath {
  return cockpitArtifactPath(`.visp/features/${featureKey}/assurance/${taskId}/${suffix}`);
}

export function screen<Id extends CockpitScreen["id"]>(
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

export function commandPaletteFrom(commands: readonly CockpitArtifactCommand[]): CockpitCommandPalette {
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

export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
}

export function isKitReadState(value: unknown): value is CockpitKitReadState {
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

export function matchesExpectedPath(
  projectPath: string,
  actualPath: string,
  expectedPath: CockpitArtifactPath
): boolean {
  return resolve(actualPath) === resolve(projectPath, expectedPath);
}

export function sanitizeReason(
  reason: string,
  absolutePath: string,
  expectedPath: CockpitArtifactPath
): string {
  const sanitized = reason.split(absolutePath).join(expectedPath).trim();
  return sanitized.length === 0 ? `Artifact state is degraded at ${expectedPath}.` : sanitized;
}

export async function inspectRootState(projectPath: string): Promise<RootState> {
  try {
    const info = await lstat(resolve(projectPath, ".visp"));
    return info.isDirectory() && !info.isSymbolicLink() ? "present" : "unavailable";
  } catch (error) {
    return isNodeError(error, "ENOENT") ? "uninitialized" : "unavailable";
  }
}
