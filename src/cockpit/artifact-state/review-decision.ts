/**
 * Resolving the review-decision pointer.
 *
 * The pointer names a decision artifact and pins its hash. Both have to agree
 * before the decision is shown, so a pointer left behind by an earlier review
 * cannot present a stale verdict as the current one.
 */

import { resolve } from "node:path";
import type { CockpitArtifactPath } from "../contracts.js";
import { REVIEW_DECISION_HASH } from "./types.js";
import { recordString } from "./projections.js";
import { assuranceArtifactPath, unresolvedArtifact } from "./results.js";
import type { BoundReviewDecisionPointer, ReadResult } from "./types.js";

export function unresolvedReviewDecision(pointerPath: CockpitArtifactPath): ReadResult {
  return unresolvedArtifact(
    "review-decision",
    "Review decision",
    pointerPath,
    "A validated current review-decision pointer is required to resolve decision history."
  );
}

export function bindReviewDecisionPointer(
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

export function reviewDecisionMatchesPointer(
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
