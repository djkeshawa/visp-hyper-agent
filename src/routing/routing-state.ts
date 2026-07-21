import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withProjectLock } from "../core/project-lock.js";

export const routingQuarantineSchema = z.object({
  taskClass: z.string(),
  untilSessionCount: z.number().int().nonnegative()
});

export const routingDecisionSchema = z.object({
  taskId: z.string(),
  taskClass: z.string(),
  tier: z.string(),
  reason: z.string(),
  at: z.string()
});

export const routingStateSchema = z.object({
  quarantines: z.array(routingQuarantineSchema),
  decisions: z.array(routingDecisionSchema)
});

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
  await withProjectLock(projectPath, async () => {
    await writeText(routingPath(projectPath), `${JSON.stringify(state, null, 2)}\n`);
  });
}

/**
 * Locked read-modify-write over the routing state, so concurrent visp-hyper
 * invocations (fan-out subagents, MCP calls) cannot drop each other's updates.
 */
export async function updateRoutingState(
  projectPath: string,
  updater: (state: RoutingState) => RoutingState | Promise<RoutingState>
): Promise<RoutingState> {
  return withProjectLock(projectPath, async () => {
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
