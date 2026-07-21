import { classifyHyperActionEnvelope } from "../kit/workflow-action-renderer.js";

export type OutputStatus =
  | "OK"
  | "PASSED"
  | "FAILED"
  | "BLOCKED"
  | "INCONCLUSIVE"
  | "ERROR";

type RecognizedFrameName =
  | "VISP_POLICY_BLOCKED"
  | "VISP_PIPELINE_BLOCKED"
  | "VISP_HYPER_ACTION_V1"
  | "VISP_WORKFLOW_ACTION_V2"
  | "VISP_CHECKPOINT_RESULT"
  | "VISP_HYPER_REPORT";

type RecognizedFrame = {
  name: RecognizedFrameName;
  body: string[];
};

const OUTPUT_STATUSES = new Set<OutputStatus>([
  "OK",
  "PASSED",
  "FAILED",
  "BLOCKED",
  "INCONCLUSIVE",
  "ERROR"
]);

const FRAME_MARKER =
  /^(BEGIN|END)_(VISP_POLICY_BLOCKED|VISP_PIPELINE_BLOCKED|VISP_HYPER_ACTION_V1|VISP_WORKFLOW_ACTION_V2|VISP_CHECKPOINT_RESULT|VISP_HYPER_REPORT)$/u;

function isOutputStatus(value: string): value is OutputStatus {
  return OUTPUT_STATUSES.has(value as OutputStatus);
}

function collectExplicitStatuses(lines: string[], signals: Set<OutputStatus>): boolean {
  let malformed = false;

  for (const line of lines) {
    if (!/^\s*status\s*:/iu.test(line)) {
      continue;
    }

    const match = line.match(/^\s*status\s*:\s*([A-Z_]+)\s*$/iu);
    const status = match?.[1]?.toUpperCase();
    if (!status || !isOutputStatus(status)) {
      malformed = true;
      continue;
    }
    signals.add(status);
  }

  return malformed;
}

function scanRecognizedFrames(lines: string[]): { frames: RecognizedFrame[]; malformed: boolean } {
  const frames: RecognizedFrame[] = [];
  let active: RecognizedFrame | null = null;
  let malformed = false;

  for (const line of lines) {
    const marker = line.trim().match(FRAME_MARKER);
    if (!marker) {
      active?.body.push(line);
      continue;
    }

    const boundary = marker[1];
    const name = marker[2] as RecognizedFrameName;
    if (boundary === "BEGIN") {
      if (active) {
        malformed = true;
        continue;
      }
      active = { name, body: [] };
      continue;
    }

    if (!active || active.name !== name) {
      malformed = true;
      continue;
    }
    frames.push(active);
    active = null;
  }

  return { frames, malformed: malformed || active !== null };
}

function collectLegacyWorkflowAction(
  frame: RecognizedFrame,
  signals: Set<OutputStatus>
): boolean {
  try {
    const value: unknown = JSON.parse(frame.body.join("\n").trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return true;
    }

    const action = value as Record<string, unknown>;
    if (action.protocolVersion !== "2.0" || typeof action.verdict !== "string") {
      return true;
    }

    return collectActionVerdict(action.verdict, signals);
  } catch {
    return true;
  }
}

function collectHyperAction(
  frame: RecognizedFrame,
  signals: Set<OutputStatus>
): boolean {
  try {
    const classification = classifyHyperActionEnvelope(
      JSON.parse(frame.body.join("\n").trim())
    );
    if (classification.kind !== "valid") {
      return true;
    }
    return collectActionVerdict(classification.verdict, signals);
  } catch {
    return true;
  }
}

function collectStandaloneHyperAction(
  text: string,
  signals: Set<OutputStatus>
): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return claimsMalformedHyperAction(trimmed);
  }

  const classification = classifyHyperActionEnvelope(value);
  if (classification.kind === "unrelated") {
    return false;
  }
  if (classification.kind === "invalid") {
    return true;
  }
  return collectActionVerdict(classification.verdict, signals);
}

function claimsMalformedHyperAction(text: string): boolean {
  const hasFrameKey = /"frameVersion"\s*:/u.test(text);
  const hasAuthorityKey = /"authority"\s*:/u.test(text);
  const hasActionKey = /"action"\s*:/u.test(text);
  const hasExactDiscriminants =
    /"frameVersion"\s*:\s*"1\.0"/u.test(text) &&
    /"authority"\s*:\s*"kit"/u.test(text);
  const hasNormalizationDiscriminant =
    /"normalizationVersion"\s*:\s*"1\.0"/u.test(text);
  return (
    (hasFrameKey && hasAuthorityKey && hasActionKey) ||
    hasExactDiscriminants ||
    (hasActionKey && hasNormalizationDiscriminant)
  );
}

function collectActionVerdict(verdict: string, signals: Set<OutputStatus>): boolean {
  switch (verdict.toLowerCase()) {
    case "ready":
      signals.add("OK");
      return false;
    case "blocked":
      signals.add("BLOCKED");
      return false;
    case "inconclusive":
      signals.add("INCONCLUSIVE");
      return false;
    default:
      return true;
  }
}

function collectCheckpointVerdicts(frame: RecognizedFrame, signals: Set<OutputStatus>): boolean {
  let verdictFound = false;
  let supportedStatusFound = false;
  let malformed = false;

  for (const line of frame.body) {
    const statusMatch = line.match(/^\s*status\s*:\s*([A-Z_]+)\s*$/iu);
    const status = statusMatch?.[1]?.toUpperCase();
    supportedStatusFound ||= Boolean(status && isOutputStatus(status));

    if (!/^\s*verdict\s*:/iu.test(line)) {
      continue;
    }

    verdictFound = true;
    const match = line.match(/^\s*verdict\s*:\s*([A-Z_]+)\s*$/iu);
    const verdict = match?.[1]?.toUpperCase();
    if (verdict === "PASSED" || verdict === "FAILED" || verdict === "INCONCLUSIVE") {
      signals.add(verdict);
    } else {
      malformed = true;
    }
  }

  return malformed || (!verdictFound && !supportedStatusFound);
}

export function deriveOutputStatus(text: string, isError: boolean): OutputStatus {
  const lines = text.split(/\r?\n/u);
  const commandSignals = new Set<OutputStatus>();
  const actionSignals = new Set<OutputStatus>();
  let actionFrameCount = 0;
  let malformed = collectExplicitStatuses(lines, commandSignals);
  const scanned = scanRecognizedFrames(lines);
  malformed ||= scanned.malformed;

  for (const frame of scanned.frames) {
    switch (frame.name) {
      case "VISP_POLICY_BLOCKED":
      case "VISP_PIPELINE_BLOCKED":
        commandSignals.add("BLOCKED");
        break;
      case "VISP_HYPER_ACTION_V1":
        actionFrameCount += 1;
        malformed ||= collectHyperAction(frame, actionSignals);
        break;
      case "VISP_WORKFLOW_ACTION_V2":
        actionFrameCount += 1;
        malformed ||= collectLegacyWorkflowAction(frame, actionSignals);
        break;
      case "VISP_CHECKPOINT_RESULT":
        malformed ||= collectCheckpointVerdicts(frame, commandSignals);
        break;
      case "VISP_HYPER_REPORT":
        commandSignals.add("OK");
        break;
    }
  }

  if (actionFrameCount === 0) {
    malformed ||= collectStandaloneHyperAction(text, actionSignals);
  } else if (actionFrameCount > 1) {
    malformed = true;
  }

  if (malformed || commandSignals.size > 1 || actionSignals.size > 1) {
    return "INCONCLUSIVE";
  }

  const commandStatus =
    commandSignals.size === 1 ? [...commandSignals][0] : undefined;
  const actionStatus = actionSignals.size === 1 ? [...actionSignals][0] : undefined;
  if (commandStatus !== undefined) {
    if (isError && (commandStatus === "OK" || commandStatus === "PASSED")) {
      return "INCONCLUSIVE";
    }
    return commandStatus;
  }
  if (actionStatus !== undefined) {
    if (isError && actionStatus === "OK") {
      return "INCONCLUSIVE";
    }
    return actionStatus;
  }
  return isError ? "ERROR" : "INCONCLUSIVE";
}
