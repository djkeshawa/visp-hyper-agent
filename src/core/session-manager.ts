import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { GitBranchSessionLocator } from "./branch-session-locator.js";
import { defaultConfig } from "./defaults.js";
import { execFileResolved } from "./executable-resolver.js";
import { ensureDir, readTextIfExists, vispPath, writeText } from "./fs-utils.js";
import { parseJsonStore } from "./json-store.js";
import { withStoreLock } from "./store-lock.js";
import { kitTaskSchema } from "../kit/kit-schemas.js";
import type { GitBaseline, HyperConfig, HyperState, SessionRecord, ToolProfile } from "./types.js";

const configSchema = z.object({
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
  skillMode: z.enum(["auto", "review"]).default("review")
  ,validationCommands: z.array(z.string()).optional()
});

const pipelineStepRecordSchema = z.object({
  taskId: z.string(),
  action: z.enum(["started", "checkpoint-passed", "checkpoint-failed", "task-injected", "escalation-issued"]),
  at: z.string(),
  detail: z.string().optional()
});

const pipelineGraphIdentitySchema = z.object({
  kind: z.enum(["visp-kit", "plan", "synthetic"]),
  source: z.string().min(1),
  featureId: z.string().min(1).optional(),
  featureSlug: z.string().min(1).optional()
});

const gitSettledPathStateSchema = z.object({
  exists: z.boolean(),
  worktreeHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  indexHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  indexMatchesWorktree: z.boolean()
});

const gitBaselineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("commit"),
    revision: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/u),
    settledPaths: z.record(gitSettledPathStateSchema).optional()
  }),
  z.object({
    kind: z.literal("unborn"),
    settledPaths: z.record(gitSettledPathStateSchema).optional()
  }),
  z.object({ kind: z.literal("unavailable"), reason: z.string().min(1) })
]);

const pipelineStateSchema = z.object({
  taskIds: z.array(z.string()),
  currentTaskId: z.string().nullable(),
  completed: z.array(z.string()),
  stepHistory: z.array(pipelineStepRecordSchema),
  // Optional so legacy pipelines parse, but graph-resolving commands must
  // reject them rather than guessing which feature reused a bare task id.
  graphIdentity: pipelineGraphIdentitySchema.optional(),
  taskKeys: z.record(z.string().min(1)).optional(),
  graphFingerprint: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  gitBaseline: gitBaselineSchema.optional(),
  injectedTaskFingerprints: z
    .record(z.string().regex(/^[a-f0-9]{64}$/u))
    .optional(),
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
      gitBaseline: gitBaselineSchema.optional(),
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
  const [branchKey, gitBaseline] = await Promise.all([
    currentBranchKey(input.projectPath),
    captureGitBaseline(input.projectPath)
  ]);
  return withStoreLock(input.projectPath, async () => {
    const state = await readState(input.projectPath);
    const now = new Date().toISOString();
    const session: SessionRecord = {
      id: `vh_${now.slice(0, 10).replaceAll("-", "")}_${randomUUID().slice(0, 8)}`,
      goal: input.goal, tool: input.tool, projectPath: input.projectPath,
      createdAt: now, updatedAt: now, phase: "implementation", relevantFiles: input.relevantFiles,
      gitBaseline
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
  updater: (session: SessionRecord) => SessionRecord,
  expectedSessionId?: string
): Promise<SessionRecord | null> {
  const branchKey = await currentBranchKey(projectPath);
  return withStoreLock(projectPath, async () => {
    const state = await readState(projectPath);
    const sessionId = resolveActiveSessionId(state, branchKey);
    if (!sessionId || (expectedSessionId !== undefined && sessionId !== expectedSessionId)) {
      return null;
    }
    const current = state.sessions[sessionId]!;
    let next = updater({ ...current, updatedAt: new Date().toISOString() });
    if (next.pipeline && !next.pipeline.gitBaseline && current.gitBaseline) {
      next = {
        ...next,
        pipeline: { ...next.pipeline, gitBaseline: current.gitBaseline }
      };
    }
    state.sessions[next.id] = next;
    await writeState(projectPath, state);
    return next;
  });
}

export function currentDir(projectPath: string): string {
  return join(projectPath, ".visp", "hyper", "current");
}

/** Capture an exact commit baseline without preventing non-Git sessions from starting. */
export async function captureGitBaseline(projectPath: string): Promise<GitBaseline> {
  try {
    const { stdout } = await execFileResolved(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: projectPath, timeout: 5_000 }
    );
    if (stdout.trim() !== "true") {
      return { kind: "unavailable", reason: "project is not inside a Git worktree" };
    }
  } catch (error) {
    return { kind: "unavailable", reason: gitFailureReason(error) };
  }

  try {
    const { stdout } = await execFileResolved(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { cwd: projectPath, timeout: 5_000 }
    );
    const revision = stdout.trim().toLowerCase();
    if (/^[a-f0-9]{40}([a-f0-9]{24})?$/u.test(revision)) {
      return { kind: "commit", revision };
    }
    return { kind: "unavailable", reason: "Git returned an invalid HEAD commit id" };
  } catch {
    return classifyUnresolvedSymbolicHead(projectPath);
  }
}

/**
 * A failed `HEAD^{commit}` is unborn only when HEAD is symbolic and its exact
 * target ref does not exist. An existing-but-unresolvable ref is corrupt (or
 * points at a non-commit) and must not be mistaken for an empty repository.
 */
async function classifyUnresolvedSymbolicHead(projectPath: string): Promise<GitBaseline> {
  let headRef: string;
  try {
    const { stdout } = await execFileResolved(
      "git",
      ["symbolic-ref", "-q", "HEAD"],
      { cwd: projectPath, timeout: 5_000 }
    );
    headRef = stdout.trim();
    if (headRef.length === 0) {
      return { kind: "unavailable", reason: "Git symbolic HEAD target is empty" };
    }
  } catch (error) {
    return { kind: "unavailable", reason: gitFailureReason(error) };
  }

  try {
    await execFileResolved(
      "git",
      ["show-ref", "--verify", "--quiet", headRef],
      { cwd: projectPath, timeout: 5_000 }
    );
  } catch (error) {
    if (gitExitCode(error) === 1) {
      return { kind: "unborn" };
    }
    return {
      kind: "unavailable",
      reason: `Git symbolic HEAD target could not be verified: ${gitFailureReason(error)}`
    };
  }

  return {
    kind: "unavailable",
    reason: `Git symbolic HEAD target ${headRef} exists but does not resolve to a commit`
  };
}

function gitExitCode(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "number" ? code : null;
}

function gitFailureReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim().length > 0
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/gu, " ").trim().slice(0, 240) || "Git command failed";
}
