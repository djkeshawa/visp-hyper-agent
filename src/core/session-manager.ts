import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { GitBranchSessionLocator } from "./branch-session-locator.js";
import { defaultConfig } from "./defaults.js";
import { ensureDir, readTextIfExists, vispPath, writeText } from "./fs-utils.js";
import { parseJsonStore } from "./json-store.js";
import { withStoreLock } from "./store-lock.js";
import { kitTaskSchema } from "../kit/kit-schemas.js";
import type { HyperConfig, HyperState, SessionRecord, ToolProfile } from "./types.js";

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
  validationCommands: z.array(z.string()).optional()
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
  activeSessionByBranch: z.record(z.string()).optional()
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
  const raw = await readTextIfExists(vispPath(projectPath, "hyper", "state.json"));
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

export function currentDir(projectPath: string): string {
  return join(projectPath, ".visp", "hyper", "current");
}
