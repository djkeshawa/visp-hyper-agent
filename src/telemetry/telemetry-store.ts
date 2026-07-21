import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withProjectLock } from "../core/project-lock.js";

export const telemetryAttemptSchema = z.object({
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
  await withProjectLock(projectPath, async () => {
    await writeText(telemetryPath(projectPath), `${JSON.stringify(data, null, 2)}\n`);
  });
}

/**
 * Append a checkpoint attempt record. `attempt` is computed as the count of
 * prior attempts for the same `taskId` plus one; `firstAttempt` is `attempt === 1`.
 * The timestamp is generated here. Returns the full persisted record.
 */
export async function appendAttempt(
  projectPath: string,
  attempt: Omit<TelemetryAttempt, "attempt" | "firstAttempt" | "at">
): Promise<TelemetryAttempt> {
  return withProjectLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    const priorForTask = data.attempts.filter((entry) => entry.taskId === attempt.taskId).length;
    const attemptNumber = priorForTask + 1;
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
 * Append a per-session token usage record. The timestamp is generated here.
 */
export async function appendUsage(
  projectPath: string,
  usage: Omit<TelemetryUsage, "at">
): Promise<void> {
  await withProjectLock(projectPath, async () => {
    const { data } = await readTelemetry(projectPath);
    data.usage.push({ ...usage, at: new Date().toISOString() });
    await writeTelemetry(projectPath, data);
  });
}
