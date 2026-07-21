import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withProjectLock } from "../core/project-lock.js";

export const telemetryAttemptSchema = z.object({
  // Optional only for legacy rows written before graph-scoped task identity.
  taskKey: z.string().min(1).optional(),
  taskId: z.string(),
  taskClass: z.string(),
  tier: z.string(),
  attempt: z.number().int().positive(),
  verifyPassed: z.boolean(),
  reviewPassed: z.boolean(),
  firstAttempt: z.boolean(),
  sessionId: z.string(),
  at: z.string()
});

export const telemetryUsageSchema = z.object({
  // Optional only for legacy rows; new writes derive this from the session id.
  usageKey: z.string().min(1).optional(),
  sessionId: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  model: z.string().optional(),
  at: z.string()
});

export const telemetryFileSchema = z.object({
  attempts: z.array(telemetryAttemptSchema),
  usage: z.array(telemetryUsageSchema)
});

export type TelemetryAttempt = z.infer<typeof telemetryAttemptSchema>;
export type TelemetryUsage = z.infer<typeof telemetryUsageSchema>;
export type TelemetryFile = z.infer<typeof telemetryFileSchema>;

export const MAX_TELEMETRY_ATTEMPTS = 1_000;
export const MAX_TELEMETRY_USAGE_RECORDS = 1_000;

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
  surfaceWarnings(warnings);
  return { data: value, warnings };
}

async function writeTelemetry(projectPath: string, data: TelemetryFile): Promise<void> {
  await withProjectLock(projectPath, async () => {
    await writeText(
      telemetryPath(projectPath),
      `${JSON.stringify(boundTelemetryFile(data), null, 2)}\n`
    );
  });
}

/**
 * Append a checkpoint attempt record. Attempt order is scoped by the durable
 * graph/task key, so reused display ids cannot contaminate first-attempt data.
 */
export async function appendAttempt(
  projectPath: string,
  attempt: Omit<TelemetryAttempt, "attempt" | "firstAttempt" | "at" | "taskKey"> & {
    taskKey: string;
  }
): Promise<TelemetryAttempt> {
  return withProjectLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    const priorAttempt = data.attempts.reduce(
      (maximum, entry) => entry.taskKey === attempt.taskKey ? Math.max(maximum, entry.attempt) : maximum,
      0
    );
    const attemptNumber = priorAttempt + 1;
    const record: TelemetryAttempt = {
      ...attempt,
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
 * Upsert one per-session token usage record. Re-running remember for the same
 * session updates that record without double-counting totals.
 */
export async function appendUsage(
  projectPath: string,
  usage: Omit<TelemetryUsage, "at" | "usageKey">
): Promise<TelemetryUsage> {
  return withProjectLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    const usageKey = usageKeyForSession(usage.sessionId);
    const matchesUsage = (entry: TelemetryUsage): boolean =>
      entry.usageKey === usageKey || (entry.usageKey === undefined && entry.sessionId === usage.sessionId);
    const existing = data.usage.filter(matchesUsage).at(-1);
    const record: TelemetryUsage = {
      usageKey,
      sessionId: usage.sessionId,
      inputTokens: usage.inputTokens ?? existing?.inputTokens,
      outputTokens: usage.outputTokens ?? existing?.outputTokens,
      model: usage.model ?? existing?.model,
      at: existing?.at ?? new Date().toISOString()
    };
    data.usage = [...data.usage.filter((entry) => !matchesUsage(entry)), record];
    await writeTelemetry(projectPath, data);
    return record;
  });
}

export function usageKeyForSession(sessionId: string): string {
  return JSON.stringify(["session", sessionId]);
}

function boundTelemetryFile(data: TelemetryFile): TelemetryFile {
  return {
    attempts: data.attempts.slice(-MAX_TELEMETRY_ATTEMPTS),
    usage: data.usage.slice(-MAX_TELEMETRY_USAGE_RECORDS)
  };
}

function surfaceWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
}
