import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig } from "./defaults.js";
import { ensureDir, readTextIfExists, vispPath, writeText } from "./fs-utils.js";
import { parseJsonStore } from "./json-store.js";
import { withStoreLock } from "./store-lock.js";
import { kitTaskSchema } from "../kit/kit-schemas.js";
import type { HyperConfig, HyperState, SessionRecord, ToolProfile } from "./types.js";

const configSchema = z.object({
  defaultTool: z.enum(["generic", "codex", "claude-code", "copilot", "opencode"]),
  tokenBudget: z.number().int().positive(),
  memoryMode: z.enum(["file", "llm-memory"]),
  memoryEndpoint: z.string().default("http://localhost:8000"),
  memoryRepoId: z.string().optional(),
  contextMode: z.literal("deterministic"),
  blockedPaths: z.array(z.string()),
  skillMode: z.enum(["auto", "review"]).default("auto")
});

const pipelineStepRecordSchema = z.object({
  taskId: z.string(),
  action: z.enum(["started", "checkpoint-passed", "checkpoint-failed"]),
  at: z.string(),
  detail: z.string().optional()
});

const pipelineStateSchema = z.object({
  taskIds: z.array(z.string()),
  currentTaskId: z.string().nullable(),
  completed: z.array(z.string()),
  stepHistory: z.array(pipelineStepRecordSchema),
  // Optional so legacy state without synthetic graphs still parses.
  syntheticTasks: z.array(kitTaskSchema).optional()
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
  )
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
    configSchema,
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
  return withStoreLock(input.projectPath, async () => {
    const state = await readState(input.projectPath);
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `vh_${now.slice(0, 10).replaceAll("-", "")}_${randomUUID().slice(0, 8)}`,
      goal: input.goal,
      tool: input.tool,
      projectPath: input.projectPath,
      createdAt: now,
      updatedAt: now,
      phase: "implementation",
      relevantFiles: input.relevantFiles
    };

    state.activeSessionId = session.id;
    state.sessions[session.id] = session;
    await writeState(input.projectPath, state);
    return session;
  });
}

export async function getActiveSession(projectPath: string): Promise<SessionRecord | null> {
  const state = await readState(projectPath);
  return state.activeSessionId ? state.sessions[state.activeSessionId] ?? null : null;
}

export async function updateActiveSession(
  projectPath: string,
  updater: (session: SessionRecord) => SessionRecord
): Promise<SessionRecord | null> {
  return withStoreLock(projectPath, async () => {
    const state = await readState(projectPath);
    if (!state.activeSessionId || !state.sessions[state.activeSessionId]) {
      return null;
    }
    const next = updater({
      ...state.sessions[state.activeSessionId],
      updatedAt: new Date().toISOString()
    });
    state.sessions[next.id] = next;
    await writeState(projectPath, state);
    return next;
  });
}

export function currentDir(projectPath: string): string {
  return join(projectPath, ".visp", "hyper", "current");
}

