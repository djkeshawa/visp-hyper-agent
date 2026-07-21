import type { NormalizedWorkflowAction } from "./workflow-action-adapter.js";

export const HYPER_ACTION_FRAME_NAME = "VISP_HYPER_ACTION_V1" as const;
export const HYPER_ACTION_FRAME_BEGIN = `BEGIN_${HYPER_ACTION_FRAME_NAME}`;
export const HYPER_ACTION_FRAME_END = `END_${HYPER_ACTION_FRAME_NAME}`;

export type PublicNormalizedWorkflowAction = Omit<NormalizedWorkflowAction, "wire">;

export type HyperActionEnvelopeV1 = Readonly<{
  frameVersion: "1.0";
  authority: "kit";
  action: PublicNormalizedWorkflowAction;
}>;

export type HyperActionEnvelopeClassification =
  | Readonly<{ kind: "valid"; verdict: NormalizedWorkflowAction["verdict"] }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unrelated" }>;

const validVerdicts = new Set<NormalizedWorkflowAction["verdict"]>([
  "ready",
  "blocked",
  "inconclusive"
]);

export function toHyperActionEnvelope(
  action: NormalizedWorkflowAction
): HyperActionEnvelopeV1 {
  const { wire: _wire, ...publicFields } = action;
  const publicAction = Object.freeze(publicFields) as PublicNormalizedWorkflowAction;
  return Object.freeze({
    frameVersion: "1.0",
    authority: "kit",
    action: publicAction
  });
}

export function renderHyperActionFrame(envelope: HyperActionEnvelopeV1): string {
  return [
    HYPER_ACTION_FRAME_BEGIN,
    JSON.stringify(envelope),
    HYPER_ACTION_FRAME_END
  ].join("\n");
}

export function classifyHyperActionEnvelope(
  value: unknown
): HyperActionEnvelopeClassification {
  if (!isRecord(value)) {
    return Object.freeze({ kind: "unrelated" });
  }

  const action = isRecord(value.action) ? value.action : undefined;
  const claimsEnvelope =
    (hasOwn(value, "frameVersion") &&
      hasOwn(value, "authority") &&
      hasOwn(value, "action")) ||
    (value.frameVersion === "1.0" && value.authority === "kit") ||
    action?.normalizationVersion === "1.0";
  if (!claimsEnvelope) {
    return Object.freeze({ kind: "unrelated" });
  }

  if (
    !hasExactKeys(value, ["frameVersion", "authority", "action"]) ||
    value.frameVersion !== "1.0" ||
    value.authority !== "kit" ||
    action === undefined ||
    action.normalizationVersion !== "1.0" ||
    hasOwn(action, "wire") ||
    typeof action.verdict !== "string" ||
    !validVerdicts.has(action.verdict as NormalizedWorkflowAction["verdict"])
  ) {
    return Object.freeze({ kind: "invalid" });
  }

  return Object.freeze({
    kind: "valid",
    verdict: action.verdict as NormalizedWorkflowAction["verdict"]
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => hasOwn(value, key));
}
