import { z } from "zod";

import { readTextIfExists, vispPath } from "../core/fs-utils.js";
import {
  INTEL_MCP_TOOL_PREFIX,
  describeIntelProvider,
  type IntelProviderStatus
} from "../install/intel-mcp-registration.js";

/**
 * P21-HYPER-01 / ADR 0014 Q4 — the scout's bounded action set and the only
 * thing that crosses the handoff boundary.
 *
 * The scouting role is navigation-only: six actions, each one intel query, each
 * producing a QueryReceipt. This module is the COLLECTOR at that boundary. It
 * takes whatever the scout emitted, keeps the rows that cite a receipt, and
 * hands the implementer validated state — never the exploratory conversation
 * that produced it. Discarding the transcript is the point of the unit: the
 * scout's job is to produce a small artifact, not a conversation.
 *
 * AUTHORITY. Hyper sequences. Everything here is shape and self-consistency:
 * does the payload cite receipts, does it contradict itself, does it stay
 * inside its action budget. Nothing here judges whether the evidence is
 * SUFFICIENT — that is Kit's decision (VSP026 G1–G6), and nothing this module
 * returns authorizes anything.
 */

/**
 * The whole scouting vocabulary. Each maps to one intel query:
 * search→repo.search_entities, callers→repo.callers, callees→repo.callees,
 * path→repo.trace_path, entity→repo.entity, tests→repo.tests_for.
 */
export const SCOUT_ACTIONS = ["search", "callers", "callees", "path", "entity", "tests"] as const;

export type ScoutAction = (typeof SCOUT_ACTIONS)[number];

/** Hard cap. On exhaustion the scout emits `unresolved`; it may not spend action 13. */
export const SCOUT_MAX_ACTIONS = 12;

export const SCOUT_FINDINGS_FILE = "scout-findings.json";

export const SCOUT_FINDINGS_PROJECT_PATH = `.visp/hyper/current/${SCOUT_FINDINGS_FILE}`;

/**
 * `unresolved[].question` is the ONE free-text channel in the forwarded state,
 * and it is there because gate condition G3 accepts an honest unresolved. Bound
 * it: an unbounded question is a transcript wearing a schema, and forwarding the
 * transcript is precisely what this unit removes.
 */
const MAX_QUESTION_CHARS = 200;
const MAX_UNRESOLVED_ENTRIES = SCOUT_MAX_ACTIONS;

/** Defensive upper bounds so a malformed payload cannot be a denial of service. */
const MAX_ROWS = 2_000;
const MAX_ID_CHARS = 512;
const MAX_PATH_CHARS = 1_024;

export type ScoutEntrypoint = {
  readonly entityId: string;
  readonly filePath: string;
  readonly line: number;
  readonly receiptId: string;
};

export type ScoutPathRow = {
  readonly relationId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: string;
  readonly receiptId: string;
};

export type ScoutAffectedTest = {
  readonly entityId: string;
  readonly filePath: string;
  readonly receiptId: string;
};

export type ScoutUnresolved = {
  readonly question: string;
  readonly attemptedActions: readonly ScoutAction[];
  readonly unknownId: string | null;
};

export type ScoutFindings = {
  readonly schemaVersion: "1.0";
  readonly taskId: string;
  readonly snapshotId: string;
  readonly repositoryInstanceId: string;
  readonly status: "resolved" | "unresolved";
  readonly entrypoints: readonly ScoutEntrypoint[];
  readonly path: readonly ScoutPathRow[];
  readonly affectedTests: readonly ScoutAffectedTest[];
  readonly unresolved: readonly ScoutUnresolved[];
  readonly receiptIds: readonly string[];
  readonly budget: { readonly actions: number; readonly maxActions: number };
};

export type ScoutFindingsReport = {
  /**
   * `absent` is not a failure — a task may legitimately have had no scout pass,
   * and Kit's gate is what decides whether that matters.
   */
  readonly state: "absent" | "rejected" | "accepted";
  /** Why the payload was rejected. Empty unless `state` is `rejected`. */
  readonly reasons: readonly string[];
  /** Rows the collector removed, each named so the loss is visible, never silent. */
  readonly dropped: readonly string[];
  readonly findings?: ScoutFindings;
  /**
   * A3. Whether anything in this project provides the `mcp__visp-intel__*`
   * tools the scout subagent declares.
   *
   * This exists because every other field here is ambiguous without it. A
   * scout with no provider obtains no receipt, so the collector drops all its
   * rows and the report reads `accepted` with an empty path — byte-identical
   * to a careful scout that genuinely found nothing. Absence and emptiness are
   * different answers and must not share a rendering.
   *
   * Present only on {@link readScoutFindings}, which knows the project;
   * {@link collectScoutFindings} stays a pure shape check.
   */
  readonly provider?: IntelProviderStatus;
};

function nonBlank(max: number): z.ZodType<string> {
  return z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, { message: "must not be blank" });
}

/**
 * Row shapes deliberately EXCLUDE `receiptId`. A missing receipt and a
 * malformed row are different failures with different consequences — the first
 * rejects the payload, the second only drops the row — so they are checked
 * separately rather than collapsed into one schema error.
 */
const entrypointShape = z.object({
  entityId: nonBlank(MAX_ID_CHARS),
  filePath: nonBlank(MAX_PATH_CHARS),
  // Zero-based, exactly as intel's SourceSpan and every repo.* answer report it.
  // Nothing adds 1 here; rendering does, once, at the display boundary.
  line: z.number().int().min(0)
});

const pathShape = z.object({
  relationId: nonBlank(MAX_ID_CHARS),
  sourceId: nonBlank(MAX_ID_CHARS),
  targetId: nonBlank(MAX_ID_CHARS),
  kind: nonBlank(128)
});

const affectedTestShape = z.object({
  entityId: nonBlank(MAX_ID_CHARS),
  filePath: nonBlank(MAX_PATH_CHARS)
});

const envelopeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  taskId: nonBlank(256),
  snapshotId: nonBlank(MAX_ID_CHARS),
  repositoryInstanceId: nonBlank(MAX_ID_CHARS),
  status: z.enum(["resolved", "unresolved"]),
  entrypoints: z.array(z.unknown()).max(MAX_ROWS),
  path: z.array(z.unknown()).max(MAX_ROWS),
  affectedTests: z.array(z.unknown()).max(MAX_ROWS),
  unresolved: z.array(z.unknown()).max(MAX_ROWS),
  receiptIds: z.array(z.string().max(MAX_ID_CHARS)).max(MAX_ROWS),
  budget: z.object({
    actions: z.number().int().min(0),
    maxActions: z.number().int().min(0)
  })
});

type Collector = {
  readonly dropped: string[];
  readonly reasons: string[];
  /** Set by any row that failed the receipt check — see `collectScoutFindings`. */
  missingReceipt: boolean;
};

function readReceiptId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>).receiptId;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value;
}

/**
 * Keep the rows that are both well-formed and receipted, keyed by IDENTITY.
 *
 * `identity` never reads a display field. Two entities named `handler` in two
 * files are two identities; a collector that deduplicated on `filePath` or a
 * symbol name would merge them and invent a false edge — the exact defect class
 * Phase 19 shipped four times.
 */
function collectRows<Shape extends object>(
  rows: readonly unknown[],
  shape: z.ZodType<Shape>,
  label: string,
  identity: (row: Shape) => string,
  collector: Collector
): Array<Shape & { receiptId: string }> {
  const kept: Array<Shape & { receiptId: string }> = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const where = `${label}[${index}]`;
    const receiptId = readReceiptId(row);
    if (receiptId === null) {
      collector.dropped.push(`${where} dropped: no receiptId`);
      collector.missingReceipt = true;
      return;
    }
    const parsed = shape.safeParse(row);
    if (!parsed.success) {
      collector.dropped.push(`${where} dropped: ${describeIssues(parsed.error)}`);
      return;
    }
    const key = identity(parsed.data);
    if (seen.has(key)) {
      collector.dropped.push(`${where} dropped: duplicate of an earlier row`);
      return;
    }
    seen.add(key);
    kept.push({ ...parsed.data, receiptId });
  });
  return kept;
}

function collectUnresolved(rows: readonly unknown[], collector: Collector): ScoutUnresolved[] {
  const kept: ScoutUnresolved[] = [];
  rows.forEach((row, index) => {
    const where = `unresolved[${index}]`;
    if (kept.length >= MAX_UNRESOLVED_ENTRIES) {
      collector.dropped.push(`${where} dropped: more than ${MAX_UNRESOLVED_ENTRIES} unresolved entries`);
      return;
    }
    if (row === null || typeof row !== "object") {
      collector.dropped.push(`${where} dropped: not an object`);
      return;
    }
    const record = row as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (question.length === 0) {
      // "Unresolved with ≥1 POPULATED entry is a successful run." An entry with
      // no question populates nothing.
      collector.dropped.push(`${where} dropped: empty question`);
      return;
    }
    const truncated = question.length > MAX_QUESTION_CHARS;
    if (truncated) {
      collector.dropped.push(`${where} question truncated to ${MAX_QUESTION_CHARS} characters`);
    }
    const rawActions = Array.isArray(record.attemptedActions) ? record.attemptedActions : [];
    const attemptedActions: ScoutAction[] = [];
    for (const action of rawActions) {
      if (typeof action === "string" && isScoutAction(action)) {
        if (!attemptedActions.includes(action)) attemptedActions.push(action);
        continue;
      }
      // Anything outside the six is not an action the scouting role may take,
      // so it is not evidence that anything was attempted.
      collector.dropped.push(`${where} dropped an attemptedAction outside the six-action set`);
    }
    const unknownId =
      typeof record.unknownId === "string" && record.unknownId.trim().length > 0
        ? record.unknownId.slice(0, MAX_ID_CHARS)
        : null;
    kept.push({
      question: truncated ? `${question.slice(0, MAX_QUESTION_CHARS)}…` : question,
      attemptedActions,
      unknownId
    });
  });
  return kept;
}

function isScoutAction(value: string): value is ScoutAction {
  return (SCOUT_ACTIONS as readonly string[]).includes(value);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
    .join("; ");
}

/**
 * Validate and normalize a scout payload.
 *
 * ADR 0014 Q4 says two things about a row with no receipt: "the collector drops
 * rows without one", and "any row without a receipt: Hyper rejects that
 * payload". Both hold at once — the row is dropped so it can never reach the
 * implementer, AND the run is rejected so the gate treats the task as having no
 * case. A receipt-less row is a claim with no evidence behind it, and silently
 * keeping the rest would leave the implementer trusting a payload Hyper knows
 * was fabricated in part.
 *
 * A malformed row is treated differently: dropped and named, but not fatal. The
 * ADR names only the receipt failure, and discarding a whole run over one badly
 * shaped row would throw away receipted evidence for a typo.
 */
export function collectScoutFindings(raw: unknown): ScoutFindingsReport {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { state: "rejected", reasons: [`scout findings are malformed: ${describeIssues(envelope.error)}`], dropped: [] };
  }
  const payload = envelope.data;
  const collector: Collector = { dropped: [], reasons: [], missingReceipt: false };

  // The budget is checked before the rows: a scout that rewrote its own cap has
  // already left the bounded action set, and its rows are not what it claims.
  if (payload.budget.maxActions !== SCOUT_MAX_ACTIONS) {
    collector.reasons.push(
      `budget.maxActions is ${payload.budget.maxActions}; the scout may not restate its own cap (${SCOUT_MAX_ACTIONS})`
    );
  }
  if (payload.budget.actions > SCOUT_MAX_ACTIONS) {
    collector.reasons.push(
      `budget.actions is ${payload.budget.actions}, over the hard cap of ${SCOUT_MAX_ACTIONS}`
    );
  }

  const entrypoints = collectRows(
    payload.entrypoints,
    entrypointShape,
    "entrypoints",
    (row) => row.entityId,
    collector
  );
  const path = collectRows(payload.path, pathShape, "path", (row) => row.relationId, collector);
  const affectedTests = collectRows(
    payload.affectedTests,
    affectedTestShape,
    "affectedTests",
    (row) => row.entityId,
    collector
  );
  const unresolved = collectUnresolved(payload.unresolved, collector);

  if (collector.missingReceipt) {
    collector.reasons.push("at least one row cited no receipt");
  }
  if (payload.status === "resolved" && path.length === 0) {
    // A silent empty path is the actual failure the ADR names. An honest
    // unresolved is a successful run; claiming resolution with nothing behind it
    // is not.
    collector.reasons.push("status is resolved but no receipted path relation survived");
  }
  if (payload.status === "unresolved" && unresolved.length === 0) {
    collector.reasons.push("status is unresolved but no populated unresolved entry survived");
  }

  if (collector.reasons.length > 0) {
    return { state: "rejected", reasons: collector.reasons, dropped: collector.dropped };
  }

  // The ledger is widened, never narrowed. Receipts from actions that produced
  // no rows (a search that found nothing) are the evidence that the scout
  // actually looked, and dropping them would make an honest unresolved look
  // like an idle one.
  const receiptIds = [
    ...new Set([
      ...payload.receiptIds.filter((id) => id.trim().length > 0),
      ...entrypoints.map((row) => row.receiptId),
      ...path.map((row) => row.receiptId),
      ...affectedTests.map((row) => row.receiptId)
    ])
  ].sort();

  return {
    state: "accepted",
    reasons: [],
    dropped: collector.dropped,
    findings: {
      schemaVersion: "1.0",
      taskId: payload.taskId,
      snapshotId: payload.snapshotId,
      repositoryInstanceId: payload.repositoryInstanceId,
      status: payload.status,
      entrypoints,
      path,
      affectedTests,
      unresolved,
      receiptIds,
      budget: { actions: payload.budget.actions, maxActions: payload.budget.maxActions }
    }
  };
}

export async function readScoutFindings(projectPath: string): Promise<ScoutFindingsReport> {
  const [text, provider] = await Promise.all([
    readTextIfExists(vispPath(projectPath, "hyper", "current", SCOUT_FINDINGS_FILE)),
    describeIntelProvider(projectPath)
  ]);
  if (text === undefined) {
    return { state: "absent", reasons: [], dropped: [], provider };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: "rejected", reasons: ["scout findings are not valid JSON"], dropped: [], provider };
  }
  return { ...collectScoutFindings(parsed), provider };
}

/**
 * State the provider fact before any rows, and shout when there is no provider.
 *
 * The order matters: a reader who sees `entrypoints: (none)` first has already
 * formed the wrong conclusion by the time an explanation arrives. The absence
 * block is deliberately blunt — its whole job is to stop an empty result being
 * scored as a negative finding about the repository.
 */
function renderProviderLines(report: ScoutFindingsReport): string[] {
  const provider = report.provider;
  if (provider === undefined) {
    return [];
  }
  if (provider.registered) {
    return [`intel_provider: registered (${provider.serverName})`];
  }
  return [
    "intel_provider: MISSING",
    "intel_provider_absent:",
    `  - ${provider.reason}`,
    `  - the scout subagent declares ${provider.declaredTools.length} ${INTEL_MCP_TOOL_PREFIX}* tools and has no provider for any of them`,
    "  - an empty or unresolved scout result here is NOT evidence that intel found nothing; it is evidence that nothing was asked",
    `  - fix: index the repository with \`visp-intel repo index\`, then \`visp init --intel-store <path> --intel-repository <id>\` to register the ${provider.serverName} MCP server`
  ];
}

/**
 * Render the forwarded state. This block is the entire scout-to-implementer
 * channel; there is no prose path alongside it.
 *
 * Line numbers are stored zero-based, as intel reports them, and +1 is applied
 * HERE and only here. Printing the stored number would put every row one line
 * off — a silent, systematic localisation error that would be measured as an
 * intel regression rather than the rendering bug it is.
 */
export function renderScoutState(report: ScoutFindingsReport): string {
  const lines = ["BEGIN_VISP_SCOUT_STATE", `state: ${report.state}`, ...renderProviderLines(report)];
  const findings = report.findings;
  if (findings) {
    lines.push(
      `task: ${findings.taskId}`,
      `snapshot: ${findings.snapshotId}`,
      `repository_instance: ${findings.repositoryInstanceId}`,
      `status: ${findings.status}`,
      `budget: ${findings.budget.actions}/${findings.budget.maxActions} actions`,
      "entrypoints:",
      ...(findings.entrypoints.length === 0
        ? ["  (none)"]
        : findings.entrypoints.map(
            (row) => `  - ${row.entityId} @ ${row.filePath}:${row.line + 1} receipt=${row.receiptId}`
          )),
      "path:",
      ...(findings.path.length === 0
        ? ["  (none)"]
        : findings.path.map(
            (row) => `  - ${row.sourceId} -${row.kind}-> ${row.targetId} relation=${row.relationId} receipt=${row.receiptId}`
          )),
      "affected_tests:",
      ...(findings.affectedTests.length === 0
        ? ["  (none)"]
        : findings.affectedTests.map(
            (row) => `  - ${row.entityId} @ ${row.filePath} receipt=${row.receiptId}`
          )),
      "unresolved:",
      ...(findings.unresolved.length === 0
        ? ["  (none)"]
        : findings.unresolved.map(
            (row) =>
              `  - ${row.question} [attempted: ${row.attemptedActions.join(", ") || "none"}] unknown=${row.unknownId ?? "none"}`
          ))
    );
  }
  if (report.reasons.length > 0) {
    lines.push("rejected_because:", ...report.reasons.map((reason) => `  - ${reason}`));
  }
  if (report.dropped.length > 0) {
    lines.push("dropped:", ...report.dropped.map((entry) => `  - ${entry}`));
  }
  lines.push("END_VISP_SCOUT_STATE");
  return lines.join("\n");
}
