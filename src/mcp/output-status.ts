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
  /^(BEGIN|END)_(VISP_POLICY_BLOCKED|VISP_PIPELINE_BLOCKED|VISP_WORKFLOW_ACTION_V2|VISP_CHECKPOINT_RESULT|VISP_HYPER_REPORT)$/u;

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

function collectWorkflowAction(frame: RecognizedFrame, signals: Set<OutputStatus>): boolean {
  try {
    const value: unknown = JSON.parse(frame.body.join("\n").trim());
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return true;
    }

    const action = value as Record<string, unknown>;
    if (action.protocolVersion !== "2.0" || typeof action.verdict !== "string") {
      return true;
    }

    switch (action.verdict.toLowerCase()) {
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
  } catch {
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
  const signals = new Set<OutputStatus>();
  let malformed = collectExplicitStatuses(lines, signals);
  const scanned = scanRecognizedFrames(lines);
  malformed ||= scanned.malformed;

  for (const frame of scanned.frames) {
    switch (frame.name) {
      case "VISP_POLICY_BLOCKED":
      case "VISP_PIPELINE_BLOCKED":
        signals.add("BLOCKED");
        break;
      case "VISP_WORKFLOW_ACTION_V2":
        malformed ||= collectWorkflowAction(frame, signals);
        break;
      case "VISP_CHECKPOINT_RESULT":
        malformed ||= collectCheckpointVerdicts(frame, signals);
        break;
      case "VISP_HYPER_REPORT":
        signals.add("OK");
        break;
    }
  }

  if (malformed || signals.size > 1) {
    return "INCONCLUSIVE";
  }
  if (signals.size === 1) {
    return [...signals][0]!;
  }
  return isError ? "ERROR" : "INCONCLUSIVE";
}
