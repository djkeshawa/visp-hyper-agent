import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { GitBranchSessionLocator } from "./branch-session-locator.js";
import { defaultConfig } from "./defaults.js";
import { ensureDir, readTextIfExists, vispPath, writeText } from "./fs-utils.js";
import { parseJsonStore } from "./json-store.js";
import { withStoreLock } from "./store-lock.js";
import { kitTaskSchema } from "../kit/kit-schemas.js";
import type {
  HyperConfig,
  HyperState,
  SessionRecord,
  ToolProfile,
  VerbActivityRecord,
  VerbOutcome
} from "./types.js";

export const hyperConfigSchema = z.object({
  defaultTool: z.enum(["generic", "codex", "claude-code", "copilot", "opencode"]),
  tokenBudget: z.number().int().positive(),
  memoryMode: z.enum(["file", "llm-memory"]),
  memoryEndpoint: z.string().default("http://localhost:8000"),
  memoryRepoId: z.string().optional(),
  contextMode: z.literal("deterministic"),
  // Defaulted so a hand-edited config missing this one field parses (keeping the
  // rest of the file) instead of the whole store being discarded to defaults.
  // Mirrors defaultConfig.blockedPaths.
  blockedPaths: z
    .array(z.string())
    .default([".env", ".env.*", "node_modules", "dist", "build", ".git"]),
  skillMode: z.enum(["auto", "review"]).default("review"),
  validationCommands: z.array(z.string()).optional(),
  // P10-US-03: which Kit binary the bridge spawns. Unset means auto-resolve
  // (VISP_KIT_BINARY env, then probe visp-kit, then fall back to visp).
  kitBinary: z.string().min(1).optional(),
  // A3: the scope the registered visp-intel MCP server is launched with.
  // Both are required by `visp-intel mcp` and neither has a default, so an
  // unset pair means the scout lane has no provider — a stated fact, never a
  // guessed store path.
  intelStore: z.string().min(1).optional(),
  intelRepository: z.string().min(1).optional()
});

const pipelineStepRecordSchema = z.object({
  taskId: z.string(),
  action: z.enum(["started", "checkpoint-passed", "checkpoint-failed", "task-injected", "escalation-issued"]),
  at: z.string(),
  detail: z.string().optional()
});

const pipelineStateSchema = z.object({
  taskIds: z.array(z.string()),
  currentTaskId: z.string().nullable(),
  completed: z.array(z.string()),
  stepHistory: z.array(pipelineStepRecordSchema),
  // Optional so legacy state without synthetic graphs still parses.
  syntheticTasks: z.array(kitTaskSchema).optional(),
  injectedTasks: z.array(kitTaskSchema).optional(),
  decisionLog: z.array(z.object({
    at: z.string(),
    taskId: z.string(),
    rule: z.string(),
    action: z.enum(["inject-remediation", "escalation-directive"]),
    detail: z.string().optional()
  })).optional()
});

const verbActivitySchema = z.object({
  at: z.string(),
  verb: z.string(),
  outcome: z.enum(["goal-reached", "human-needed", "blocked", "stalled", "kit-unavailable", "refused"]),
  detail: z.string().optional()
});

const stateSchema = z.object({
  activeSessionId: z.string().nullable(),
  sessions: z.record(
    z.object({
      id: z.string(),
      goal: z.string(),
      tool: z.enum(["generic", "codex", "claude-code", "copilot", "opencode"]),
      projectPath: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
      phase: z.enum(["initialized", "implementation", "review", "remembered"]),
      relevantFiles: z.array(z.string()),
      pipeline: pipelineStateSchema.optional()
    })
  ),
  activeSessionByBranch: z.record(z.string()).optional(),
  // `.catch([])` deliberately, unlike every other field here. Activity is an
  // audit trail, not domain state: a row this build does not understand (a
  // newer outcome name, a hand-edit) must cost the reader that row, never the
  // sessions in the same file. Everything else stays strict, because a
  // malformed session IS the thing the store exists to hold.
  activity: z.array(verbActivitySchema).catch([]).optional()
});

export async function initializeProject(projectPath: string, force = false): Promise<void> {
  await ensureDir(vispPath(projectPath, "hyper", "current"));
  await ensureDir(vispPath(projectPath, "memory", "session-history"));

  const configPath = vispPath(projectPath, "hyper", "config.json");
  const statePath = vispPath(projectPath, "hyper", "state.json");

  if (force || !(await readTextIfExists(configPath))) {
    await writeText(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);
  }

  if (force || !(await readTextIfExists(statePath))) {
    await writeText(statePath, `${JSON.stringify({ activeSessionId: null, sessions: {} }, null, 2)}\n`);
  }
}

function emptyState(): HyperState {
  return { activeSessionId: null, sessions: {} };
}

const branchLocator = new GitBranchSessionLocator();

async function currentBranchKey(projectPath: string): Promise<string> {
  const branch = await branchLocator.currentBranch(projectPath);
  return branchLocator.sessionKey(projectPath, branch);
}

function resolveActiveSessionId(state: HyperState, branchKey: string): string | null {
  const branchSessionId = state.activeSessionByBranch?.[branchKey];
  if (branchSessionId && state.sessions[branchSessionId]) return branchSessionId;
  return state.activeSessionId && state.sessions[state.activeSessionId] ? state.activeSessionId : null;
}

/**
 * Read the hyper config. DEGRADE, NEVER CRASH: a corrupt or schema-invalid
 * `config.json` falls back to the built-in defaults plus a stderr warning
 * rather than throwing — every command reads this with no surrounding
 * try-catch, so a throw here would take down the whole CLI.
 */
export async function readConfig(projectPath: string): Promise<HyperConfig> {
  await initializeProject(projectPath);
  const raw = await readTextIfExists(vispPath(projectPath, "hyper", "config.json"));
  const { value, warnings } = parseJsonStore(
    raw,
    hyperConfigSchema,
    () => defaultConfig,
    "config.json",
    "the default configuration"
  );
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  return value;
}

/**
 * Read the hyper session state. DEGRADE, NEVER CRASH: a corrupt or
 * schema-invalid `state.json` falls back to an empty session state plus a
 * stderr warning rather than throwing.
 */
export async function readState(projectPath: string): Promise<HyperState> {
  await initializeProject(projectPath);
  return (await readStateIfInitialized(projectPath)) ?? emptyState();
}

/**
 * Read the state store WITHOUT creating it. Returns null when Hyper has never
 * been initialized here.
 *
 * `readState` initializes as a side effect, which is right for the verbs that
 * are about to write. It is wrong for a reporting surface: `visp status`
 * calling `readState` would create `.visp/hyper/` in a project that has never
 * run Hyper, and the next `visp doctor` would then read that freshly minted
 * empty store as "initialized" — inventing exactly the ambiguity this work
 * exists to remove.
 */
export async function readStateIfInitialized(projectPath: string): Promise<HyperState | null> {
  const raw = await readTextIfExists(vispPath(projectPath, "hyper", "state.json"));
  if (raw === undefined) return null;
  const { value, warnings } = parseJsonStore(
    raw,
    stateSchema,
    emptyState,
    "state.json",
    "an empty session state"
  );
  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }
  return value;
}

export async function writeState(projectPath: string, state: HyperState): Promise<void> {
  await writeText(vispPath(projectPath, "hyper", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function createSession(input: {
  projectPath: string;
  goal: string;
  tool: ToolProfile;
  relevantFiles: string[];
}): Promise<SessionRecord> {
  const branchKey = await currentBranchKey(input.projectPath);
  return withStoreLock(input.projectPath, async () => {
    const state = await readState(input.projectPath);
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `vh_${now.slice(0, 10).replaceAll("-", "")}_${randomUUID().slice(0, 8)}`,
      goal: input.goal, tool: input.tool, projectPath: input.projectPath,
      createdAt: now, updatedAt: now, phase: "implementation", relevantFiles: input.relevantFiles
    };
    state.activeSessionId = session.id;
    state.sessions[session.id] = session;
    state.activeSessionByBranch = { ...state.activeSessionByBranch, [branchKey]: session.id };
    await writeState(input.projectPath, state);
    return session;
  });
}

/**
 * How many verb records the store keeps. Enough to show the shape of a working
 * session; small enough that state.json stays a file a human reads.
 */
export const MAX_ACTIVITY_RECORDS = 20;

/** Detail is evidence, not prose: one line, clipped, never re-executed. */
const MAX_ACTIVITY_DETAIL = 200;

function clipDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const line = detail.split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return undefined;
  return line.length > MAX_ACTIVITY_DETAIL ? `${line.slice(0, MAX_ACTIVITY_DETAIL - 1)}…` : line;
}

/**
 * Record that a work-driving verb ran here, and how it ended.
 *
 * The eighth silent failure was an empty `state.json` after `visp setup`,
 * `visp new` and a full working session: only `work`/`start` create sessions,
 * so a run driven entirely through the Kit-backed verbs left the coordinator's
 * store byte-identical to a project Hyper had never touched. That file could
 * not answer the one question an evaluation asks of it.
 *
 * DEGRADE, NEVER CRASH: this is bookkeeping on the way out of a verb that has
 * already done its work and printed its answer. A failure to write the record
 * warns and returns; it must never change the verb's exit code or swallow the
 * result the user is waiting on.
 */
export async function recordVerbActivity(
  projectPath: string,
  entry: { verb: string; outcome: VerbOutcome; detail?: string }
): Promise<void> {
  try {
    await withStoreLock(projectPath, async () => {
      const state = await readState(projectPath);
      const detail = clipDetail(entry.detail);
      const record: VerbActivityRecord = {
        at: new Date().toISOString(),
        verb: entry.verb,
        outcome: entry.outcome,
        ...(detail === undefined ? {} : { detail })
      };
      state.activity = [...(state.activity ?? []), record].slice(-MAX_ACTIVITY_RECORDS);
      await writeState(projectPath, state);
    });
  } catch (error) {
    console.warn(
      `warning: could not record ${entry.verb} in .visp/hyper/state.json (${
        error instanceof Error ? error.message : String(error)
      }); the run itself is unaffected, but this project's Hyper activity trail is now incomplete.`
    );
  }
}

export async function getActiveSession(projectPath: string): Promise<SessionRecord | null> {
  const [state, branchKey] = await Promise.all([readState(projectPath), currentBranchKey(projectPath)]);
  const sessionId = resolveActiveSessionId(state, branchKey);
  return sessionId ? state.sessions[sessionId] ?? null : null;
}

export async function updateActiveSession(
  projectPath: string,
  updater: (session: SessionRecord) => SessionRecord
): Promise<SessionRecord | null> {
  const branchKey = await currentBranchKey(projectPath);
  return withStoreLock(projectPath, async () => {
    const state = await readState(projectPath);
    const sessionId = resolveActiveSessionId(state, branchKey);
    if (!sessionId) return null;
    const next = updater({ ...state.sessions[sessionId]!, updatedAt: new Date().toISOString() });
    state.sessions[next.id] = next;
    await writeState(projectPath, state);
    return next;
  });
}

/** What the store says about Hyper's own involvement in this project. */
export type CoordinationSummary = {
  sessionCount: number;
  activityCount: number;
  lastActivity?: VerbActivityRecord;
  /**
   * Work-driving verbs ran here and not one session was ever recorded — the
   * exact shape of the eighth silent failure. True is the loud case.
   */
  drivenWithoutSession: boolean;
};

/** Pure, so both `doctor` and `status` read the store the same way. */
export function summarizeCoordination(state: HyperState): CoordinationSummary {
  const activity = state.activity ?? [];
  const sessionCount = Object.keys(state.sessions).length;
  return {
    sessionCount,
    activityCount: activity.length,
    ...(activity.length > 0 ? { lastActivity: activity[activity.length - 1]! } : {}),
    drivenWithoutSession: sessionCount === 0 && activity.length > 0
  };
}

/**
 * The one sentence both surfaces say when Hyper drove work here and recorded
 * no session. Shared so `doctor` and `status` cannot drift into two different
 * accounts of the same file.
 */
export function renderDrivenWithoutSession(summary: CoordinationSummary): string {
  const last = summary.lastActivity;
  const lastPart =
    last === undefined
      ? ""
      : ` The last was \`visp ${last.verb}\` at ${last.at} (${last.outcome}${
          last.detail === undefined ? "" : `: ${last.detail}`
        }).`;
  return (
    `Hyper ran ${summary.activityCount} work-driving verb${summary.activityCount === 1 ? "" : "s"} in this ` +
    `project and recorded NO session.${lastPart} Nothing has gone through \`visp work\`, so Hyper holds no ` +
    "context manifest, no checkpoint evidence and no memory for this work — whatever was built here was not " +
    "coordinated by Hyper."
  );
}

export function currentDir(projectPath: string): string {
  return join(projectPath, ".visp", "hyper", "current");
}
