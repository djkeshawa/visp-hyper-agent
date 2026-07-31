import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withStoreLock } from "../core/store-lock.js";
import {
  assuranceProfileSchema,
  riskFactorsSchema,
  riskLevelSchema,
  riskLevelValues,
  taskClassSchema,
  taskClassValues
} from "../kit/workflow-action-protocol.js";

/**
 * What routing predicted for this attempt's cohort, captured from the evidence
 * that existed *before* the attempt was recorded. This is the prediction half of
 * the calibration pair: the outcome half is `verdict` on the same record.
 *
 * P8-01. Calibration asks whether attempts predicted to pass at rate p actually
 * pass at rate p. That question needs both halves stored together, on a
 * prediction that could not see its own outcome.
 *
 * THIS IS OBSERVATIONAL ONLY. Nothing here feeds back into a routing decision,
 * and a prediction never widens what an action may touch — Kit remains the sole
 * authority for permission, scope, evidence sufficiency, and completion.
 */
export const attemptPredictionSchema = z.object({
  /** Historical pass rate for the cohort at decision time; null when unknown. */
  passRate: z.number().min(0).max(1).nullable(),
  /** 95% Wilson lower bound behind that rate; null when unknown. */
  lowerConfidenceBound: z.number().min(0).max(1).nullable(),
  /** Decided samples backing the rate. Zero means the prediction was uninformed. */
  samples: z.number().int().nonnegative(),
  /** Attempts excluded from the denominator because they were inconclusive. */
  inconclusive: z.number().int().nonnegative(),
  /** Tier routing suggested, and the reason it gave. */
  suggestedTier: z.string().min(1),
  reason: z.string(),
  /** Tier actually used. A mismatch is a real signal, so it is recorded. */
  tierUsed: z.string().min(1)
});

export const telemetryAttemptSchema = z.object({
  taskId: z.string(),
  featureId: z.string().min(1).nullable().optional(),
  workItemKey: z.string().min(1).optional(),
  taskClass: taskClassSchema.nullable(),
  riskLevel: riskLevelSchema.nullable(),
  riskFactors: riskFactorsSchema.nullable(),
  assuranceProfile: assuranceProfileSchema.nullable(),
  host: z.string().min(1),
  modelId: z.string().min(1),
  modelVersion: z.string().min(1).nullable(),
  projectPreset: z.string().min(1),
  protocolVersion: z.string().min(1),
  kitVersion: z.string().min(1),
  hyperVersion: z.string().min(1),
  tier: z.string(),
  attempt: z.number().int().positive(),
  verifyPassed: z.boolean(),
  reviewPassed: z.boolean(),
  verdict: z.enum(["passed", "failed", "inconclusive"]),
  evidenceSource: z.enum(["kit", "local"]),
  firstAttempt: z.boolean(),
  sessionId: z.string(),
  at: z.string(),
  /**
   * Null means this attempt cannot be calibrated — either it predates P8-01 or
   * no prediction was available. It is never back-filled: inventing a prediction
   * after the outcome is known is exactly the thing calibration exists to detect.
   */
  prediction: attemptPredictionSchema.nullable()
});

export const telemetryUsageSchema = z.object({
  sessionId: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  at: z.string()
});

const riskLevels = new Set<string>(riskLevelValues);
const taskClasses = new Set<string>(taskClassValues);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateTelemetryFile(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.attempts)) {
    return value;
  }

  const attempts = value.attempts.map((entry) => {
    if (!isRecord(entry)) {
      return entry;
    }
    const legacyRiskLevel =
      typeof entry.taskClass === "string" && riskLevels.has(entry.taskClass)
        ? entry.taskClass
        : undefined;
    const taskClass =
      typeof entry.taskClass === "string" && !taskClasses.has(entry.taskClass)
        ? null
        : entry.taskClass;

    return {
      ...entry,
      featureId: entry.featureId ?? null,
      workItemKey: entry.workItemKey ?? entry.taskId,
      taskClass,
      riskLevel: legacyRiskLevel ?? entry.riskLevel ?? null,
      riskFactors: entry.riskFactors ?? null,
      assuranceProfile: entry.assuranceProfile ?? null,
      host: entry.host ?? "unknown",
      modelId: entry.modelId ?? entry.tier ?? "unknown",
      modelVersion: entry.modelVersion ?? null,
      projectPreset: entry.projectPreset ?? "unknown",
      protocolVersion: entry.protocolVersion ?? "legacy",
      kitVersion: entry.kitVersion ?? "unknown",
      hyperVersion: entry.hyperVersion ?? "legacy",
      verdict:
        entry.verdict ??
        (entry.verifyPassed === true && entry.reviewPassed === true ? "passed" : "inconclusive"),
      evidenceSource: entry.evidenceSource ?? "local",
      // Records written before P8-01 carry no prediction and stay readable as
      // un-calibratable. Reconstructing one now would mean deriving it from
      // history that already contains this attempt's own outcome.
      prediction: entry.prediction ?? null
    };
  });

  return { ...value, attempts };
}

export const telemetryFileSchema = z.preprocess(
  migrateTelemetryFile,
  z.object({
    attempts: z.array(telemetryAttemptSchema),
    usage: z.array(telemetryUsageSchema)
  })
);

export type AttemptPrediction = z.infer<typeof attemptPredictionSchema>;
export type TelemetryAttempt = z.infer<typeof telemetryAttemptSchema>;
export type TelemetryUsage = z.infer<typeof telemetryUsageSchema>;
export type TelemetryFile = z.infer<typeof telemetryFileSchema>;

function telemetryPath(projectPath: string): string {
  return vispPath(projectPath, "hyper", "telemetry.json");
}

/**
 * Read the telemetry store. A missing file resolves to an empty store with no
 * warnings; a corrupt or schema-invalid file resolves to an empty store plus a
 * single warning so callers can surface it without failing.
 */
export async function readTelemetry(
  projectPath: string
): Promise<{ data: TelemetryFile; warnings: string[] }> {
  const raw = await readTextIfExists(telemetryPath(projectPath));
  const { value, warnings } = parseJsonStore(
    raw,
    telemetryFileSchema,
    () => ({ attempts: [], usage: [] }),
    "telemetry.json",
    "an empty store"
  );
  return { data: value, warnings };
}

async function writeTelemetry(projectPath: string, data: TelemetryFile): Promise<void> {
  await writeText(telemetryPath(projectPath), `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Append a checkpoint attempt record. `attempt` is computed as the count of
 * prior attempts for the same `taskId` plus one; `firstAttempt` is `attempt === 1`.
 * The timestamp is generated here. Returns the full persisted record.
 */
export async function appendAttempt(
  projectPath: string,
  attempt: Omit<TelemetryAttempt, "attempt" | "firstAttempt" | "at" | "prediction"> & {
    readonly prediction?: AttemptPrediction | null;
  }
): Promise<TelemetryAttempt> {
  return withStoreLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    const workItemKey =
      attempt.workItemKey ??
      `${attempt.featureId ?? "local"}:${attempt.sessionId}:${attempt.taskId}`;
    const priorForTask = data.attempts.filter(
      (entry) => (entry.workItemKey ?? entry.taskId) === workItemKey
    ).length;
    const attemptNumber = priorForTask + 1;
    const record: TelemetryAttempt = {
      ...attempt,
      prediction: attempt.prediction ?? null,
      workItemKey,
      attempt: attemptNumber,
      firstAttempt: attemptNumber === 1,
      at: new Date().toISOString()
    };
    data.attempts.push(record);
    await writeTelemetry(projectPath, data);
    return record;
  });
}

/**
 * Append a per-session token usage record. The timestamp is generated here.
 */
export async function appendUsage(
  projectPath: string,
  usage: Omit<TelemetryUsage, "at">
): Promise<void> {
  await withStoreLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    data.usage.push({ ...usage, at: new Date().toISOString() });
    await writeTelemetry(projectPath, data);
  });
}
