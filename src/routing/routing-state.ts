import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withStoreLock } from "../core/store-lock.js";
import {
  riskFactorsSchema,
  riskLevelSchema,
  riskLevelValues,
  taskClassSchema,
  taskClassValues
} from "../kit/workflow-action-protocol.js";

export const routingQuarantineSchema = z.object({
  taskClass: taskClassSchema.nullable(),
  untilSessionCount: z.number().int().nonnegative()
});

export const routingDecisionSchema = z.object({
  taskId: z.string(),
  taskClass: taskClassSchema.nullable(),
  riskLevel: riskLevelSchema.nullable(),
  riskFactors: riskFactorsSchema.nullable(),
  tier: z.string(),
  reason: z.string(),
  at: z.string()
});

const taskClasses = new Set<string>(taskClassValues);
const riskLevels = new Set<string>(riskLevelValues);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migratedTaskClass(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return taskClasses.has(value) ? value : null;
  }
  return undefined;
}

function migrateRoutingState(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const migratedQuarantines = Array.isArray(value.quarantines)
    ? value.quarantines.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }
        const taskClass = migratedTaskClass(entry.taskClass);
        return taskClass === undefined ? [] : [{ ...entry, taskClass }];
      })
    : value.quarantines;

  const quarantines = Array.isArray(migratedQuarantines)
    ? [...migratedQuarantines.reduce((byClass, quarantine) => {
        if (!isRecord(quarantine)) {
          return byClass;
        }
        const key = quarantine.taskClass === null ? null : String(quarantine.taskClass);
        const existing = byClass.get(key);
        if (
          !existing ||
          (typeof quarantine.untilSessionCount === "number" &&
            quarantine.untilSessionCount > Number(existing.untilSessionCount))
        ) {
          byClass.set(key, quarantine);
        }
        return byClass;
      }, new Map<string | null, Record<string, unknown>>()).values()]
    : migratedQuarantines;

  const decisions = Array.isArray(value.decisions)
    ? value.decisions.flatMap((entry) => {
        if (!isRecord(entry)) {
          return [];
        }
        const legacyRiskLevel =
          typeof entry.taskClass === "string" && riskLevels.has(entry.taskClass)
            ? entry.taskClass
            : undefined;
        const taskClass = migratedTaskClass(entry.taskClass);
        if (taskClass === undefined) {
          return [];
        }
        return [{
          ...entry,
          taskClass,
          riskLevel: legacyRiskLevel ?? entry.riskLevel ?? null,
          riskFactors: entry.riskFactors ?? null
        }];
      })
    : value.decisions;

  return { ...value, quarantines, decisions };
}

export const routingStateSchema = z.preprocess(
  migrateRoutingState,
  z.object({
    quarantines: z.array(routingQuarantineSchema),
    decisions: z.array(routingDecisionSchema)
  })
);

export type RoutingQuarantine = z.infer<typeof routingQuarantineSchema>;
export type RoutingDecision = z.infer<typeof routingDecisionSchema>;
export type RoutingState = z.infer<typeof routingStateSchema>;

function routingPath(projectPath: string): string {
  return vispPath(projectPath, "hyper", "routing.json");
}

function emptyState(): RoutingState {
  return { quarantines: [], decisions: [] };
}

/**
 * Read the routing state. A missing file resolves to an empty state with no
 * warnings; a corrupt or schema-invalid file resolves to an empty state plus a
 * single warning so callers can surface it without failing.
 */
export async function readRoutingState(
  projectPath: string
): Promise<{ state: RoutingState; warnings: string[] }> {
  const raw = await readTextIfExists(routingPath(projectPath));
  const { value, warnings } = parseJsonStore(
    raw,
    routingStateSchema,
    emptyState,
    "routing.json",
    "an empty state"
  );
  return { state: value, warnings };
}

export async function writeRoutingState(projectPath: string, state: RoutingState): Promise<void> {
  await writeText(routingPath(projectPath), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Locked read-modify-write over the routing state, so concurrent visp-hyper
 * invocations (fan-out subagents, MCP calls) cannot drop each other's updates.
 */
export async function updateRoutingState(
  projectPath: string,
  updater: (state: RoutingState) => RoutingState | Promise<RoutingState>
): Promise<RoutingState> {
  return withStoreLock(projectPath, async () => {
    const { state } = await readRoutingState(projectPath);
    const next = await updater(state);
    await writeRoutingState(projectPath, next);
    return next;
  });
}

const MAX_DECISIONS = 50;

/**
 * Append an advisory routing decision to the persisted state, capping the
 * history at the most recent {@link MAX_DECISIONS} entries. Never throws on a
 * missing/corrupt store — it reads defensively and writes a clean state.
 */
export async function recordRoutingDecision(
  projectPath: string,
  decision: RoutingDecision
): Promise<void> {
  await updateRoutingState(projectPath, (state) => ({
    ...state,
    decisions: [...state.decisions, decision].slice(-MAX_DECISIONS)
  }));
}
