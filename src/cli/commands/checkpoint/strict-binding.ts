/**
 * Whether a strict checkpoint is bound to context it can trust.
 *
 * This answers one question: is the session, its branch, and the Kit context
 * manifest behind it pinned tightly enough that evidence recorded now means
 * what it claims? Every failure is returned as a reason code rather than
 * thrown, because a checkpoint that cannot prove its binding must degrade
 * loudly, not crash.
 */

import { posix, win32 } from "node:path";
import { GitBranchSessionLocator } from "../../../core/branch-session-locator.js";
import { readTextIfExists, vispPath } from "../../../core/fs-utils.js";
import { KitCommandBridge } from "../../../kit/kit-command-bridge.js";
import type { NormalizedWorkflowAction } from "../../../kit/workflow-action-adapter.js";
import { routingTaskFromAction } from "../../../routing/routing-context.js";
import type { RoutingTaskDescriptor } from "../../../routing/routing-context.js";
import { isNonEmptyString, isRecord, isSha256 } from "../../../core/guards.js";

export type StrictCheckpointBinding =
  | { ok: true }
  | {
      ok: false;
      reasonCode: "strict_session_unavailable" | "strict_session_binding_unavailable";
      reason: string;
      contextFreshness: "untracked" | "missing" | "error";
    };

const strictSessionLocator = new GitBranchSessionLocator();

export async function validateStrictCheckpointBinding(
  projectPath: string,
  taskId: string
): Promise<StrictCheckpointBinding> {
  let stateText: string | undefined;
  try {
    stateText = await readTextIfExists(vispPath(projectPath, "hyper", "state.json"));
  } catch {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state could not be read.",
      "untracked"
    );
  }
  if (!stateText) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "No active Hyper session state exists for this configured checkpoint.",
      "untracked"
    );
  }

  let state: unknown;
  try {
    state = JSON.parse(stateText) as unknown;
  } catch {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state is unreadable.",
      "untracked"
    );
  }
  if (!isRecord(state) || !isRecord(state.sessions)) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "The active Hyper session state is malformed.",
      "untracked"
    );
  }

  const branch = await strictSessionLocator.currentBranch(projectPath);
  const branchKey = strictSessionLocator.sessionKey(projectPath, branch);
  const branchSessionId = isRecord(state.activeSessionByBranch) &&
      typeof state.activeSessionByBranch[branchKey] === "string" &&
      isRecord(state.sessions[state.activeSessionByBranch[branchKey]])
    ? state.activeSessionByBranch[branchKey]
    : undefined;
  const fallbackSessionId = typeof state.activeSessionId === "string" &&
      isRecord(state.sessions[state.activeSessionId])
    ? state.activeSessionId
    : undefined;
  const sessionId = branchSessionId ?? fallbackSessionId;
  const session = sessionId ? state.sessions[sessionId] : undefined;
  if (!sessionId || !isRecord(session) || session.id !== sessionId) {
    return strictBindingFailure(
      "strict_session_unavailable",
      "No coherent active Hyper session exists for this configured checkpoint.",
      "untracked"
    );
  }
  if (!isNonEmptyString(session.goal) || session.projectPath !== projectPath) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The active Hyper session is not bound to this project and goal.",
      "error"
    );
  }

  let manifestText: string | undefined;
  try {
    manifestText = await readTextIfExists(
      vispPath(projectPath, "hyper", "current", "context-manifest.json")
    );
  } catch {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest could not be read.",
      "error"
    );
  }
  if (!manifestText) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is missing.",
      "missing"
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText) as unknown;
  } catch {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is unreadable.",
      "error"
    );
  }
  if (!isRecord(manifest)) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest is malformed.",
      "error"
    );
  }
  if (manifest.sessionId !== sessionId) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the active session ID.",
      "error"
    );
  }
  if (manifest.taskId !== taskId) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the requested task ID. Re-run `visp work \"<goal>\"` to rebind the session to the task Kit currently selects.",
      "error"
    );
  }
  if (manifest.goal !== session.goal) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      "The current context manifest does not match the active session goal.",
      "error"
    );
  }

  const bindingIssue = kitManifestBindingIssue(manifest);
  if (bindingIssue) {
    return strictBindingFailure(
      "strict_session_binding_unavailable",
      bindingIssue,
      "error"
    );
  }
  return { ok: true };
}

export type StrictRoutingBinding = {
  featureId: string;
  task: RoutingTaskDescriptor;
  protocolVersion: string;
  kitVersion: string;
};

export async function readStrictRoutingBinding(
  bridge: KitCommandBridge,
  taskId: string
): Promise<StrictRoutingBinding | null> {
  const contract = await bridge.integrationContractDiagnostic();
  if (!contract.ok) {
    return null;
  }
  const action = await bridge.nextCanonicalActionDiagnostic("auto", contract.value);
  if (!action.ok || action.value.verdict !== "ready") return null;
  return routingBindingFromAction(action.value, contract.value.kit.version, taskId);
}

export function routingBindingFromAction(
  action: NormalizedWorkflowAction,
  kitVersion: string,
  taskId: string
): StrictRoutingBinding | null {
  if (
    action.task?.id !== taskId ||
    action.feature.state !== "available" ||
    action.feature.value === null
  ) return null;
  const task = routingTaskFromAction(action);
  if (!task) return null;
  return {
    featureId: action.feature.value.id,
    task,
    protocolVersion: action.source.protocolVersion,
    kitVersion
  };
}

function kitManifestBindingIssue(manifest: Record<string, unknown>): string | undefined {
  const contextArtifact = pinnedArtifact(manifest.contextArtifact);
  if (!contextArtifact) {
    return "The current context manifest has no valid Kit context artifact binding.";
  }

  if (!Array.isArray(manifest.artifactProvenance) || manifest.artifactProvenance.length === 0) {
    return "The current context manifest has no Kit artifact provenance binding.";
  }
  const provenance = manifest.artifactProvenance.map((value) => kitProvenanceArtifact(value));
  if (provenance.some((value) => value === null)) {
    return "The current context manifest has malformed Kit artifact provenance.";
  }
  const pinnedProvenance = provenance.filter(
    (value): value is { path: string; hash: string } => value !== null
  );
  if (hasDuplicateArtifactPath(pinnedProvenance)) {
    return "The current context manifest has duplicate or conflicting Kit artifact provenance paths.";
  }

  if (!isRecord(manifest.kitReadContract)) {
    return "The current context manifest has no Kit read contract binding.";
  }
  const readContract = manifest.kitReadContract;
  if (
    readContract.contractVersion !== "2.0" ||
    readContract.readContractVersion !== "0.1" ||
    !Array.isArray(readContract.requiredArtifacts) ||
    readContract.requiredArtifacts.length === 0
  ) {
    return "The current context manifest has an incomplete Kit read contract binding.";
  }
  if (
    !isRecord(readContract.freshnessPolicy) ||
    readContract.freshnessPolicy.contextPackHashPinned !== true ||
    readContract.freshnessPolicy.provenanceArtifactsHashPinned !== true ||
    !Array.isArray(readContract.freshnessPolicy.staleContextBlocks) ||
    !readContract.freshnessPolicy.staleContextBlocks.every(isNonEmptyString) ||
    !readContract.freshnessPolicy.staleContextBlocks.includes("checkpoint")
  ) {
    return "The current context manifest has an incomplete Kit freshness-policy binding.";
  }
  const requiredArtifacts = readContract.requiredArtifacts.map((value) => requiredKitArtifact(value));
  if (requiredArtifacts.some((value) => value === null)) {
    return "The current context manifest has malformed Kit required-artifact bindings.";
  }
  const boundArtifacts = requiredArtifacts.filter(
    (value): value is RequiredKitArtifact =>
      value !== null
  );
  const checkpointArtifacts = boundArtifacts.filter((artifact) =>
    artifact.requiredFor.includes("checkpoint")
  );
  if (hasDuplicateArtifactPath(checkpointArtifacts)) {
    return "The current context manifest has duplicate or conflicting Kit checkpoint read paths.";
  }
  if (checkpointArtifacts.some((artifact) => artifact.freshness !== "hash-pinned")) {
    return "The current context manifest has a checkpoint read that is not hash-pinned.";
  }
  const taskGraphArtifacts = checkpointArtifacts.filter(
    (artifact) => artifact.role === "task-graph"
  );
  const contextPackArtifacts = checkpointArtifacts.filter(
    (artifact) => artifact.role === "context-pack"
  );
  if (
    taskGraphArtifacts.length !== 1 ||
    taskGraphArtifacts[0].mimeType !== "application/json" ||
    contextPackArtifacts.length !== 1 ||
    contextPackArtifacts[0].mimeType !== "application/json"
  ) {
    return "The current context manifest must bind one JSON task graph and one JSON context pack for checkpoint.";
  }
  if (
    !pinnedProvenance.some(
      (artifact) =>
        artifact.path === contextArtifact.path && artifact.hash === contextArtifact.hash
    )
  ) {
    return "The Kit context artifact is not bound to its pinned provenance.";
  }
  if (
    contextPackArtifacts[0].path !== contextArtifact.path
  ) {
    return "The Kit context artifact is not bound to a checkpoint read requirement.";
  }
  const unpinnedCheckpointArtifact = checkpointArtifacts.find(
    (artifact) => !pinnedProvenance.some((provenance) => provenance.path === artifact.path)
  );
  if (unpinnedCheckpointArtifact) {
    return `The Kit checkpoint read artifact is not bound to pinned provenance: ${unpinnedCheckpointArtifact.path}.`;
  }
  return undefined;
}

function pinnedArtifact(value: unknown): { path: string; hash: string } | null {
  if (!isRecord(value)) return null;
  const path = normalizedArtifactPath(value.path);
  return path && isSha256(value.hash) && value.hashAlgorithm === "sha256"
    ? { path, hash: value.hash }
    : null;
}

function kitProvenanceArtifact(value: unknown): { path: string; hash: string } | null {
  if (!isRecord(value) || value.source !== "visp-kit") return null;
  return pinnedArtifact(value);
}

type RequiredKitArtifact = {
  path: string;
  role: string;
  mimeType: string;
  requiredFor: string[];
  freshness: string;
};

function requiredKitArtifact(value: unknown): RequiredKitArtifact | null {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.role) ||
    !isNonEmptyString(value.mimeType) ||
    !isNonEmptyString(value.freshness) ||
    !Array.isArray(value.requiredFor) ||
    !value.requiredFor.every(isNonEmptyString)
  ) {
    return null;
  }
  const path = normalizedArtifactPath(value.path);
  return path
    ? {
        path,
        role: value.role,
        mimeType: value.mimeType,
        requiredFor: value.requiredFor,
        freshness: value.freshness
      }
    : null;
}

function normalizedArtifactPath(value: unknown): string | null {
  if (!isNonEmptyString(value) || value !== value.trim()) return null;
  if (
    /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value) ||
    /^[a-z]:/iu.test(value) ||
    posix.isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.split("/").includes("..")
  ) {
    return null;
  }
  const normalized = posix.normalize(value);
  return normalized === "." || normalized.endsWith("/") || normalized !== value
    ? null
    : normalized;
}

function hasDuplicateArtifactPath(values: Array<{ path: string }>): boolean {
  const paths = new Set<string>();
  for (const value of values) {
    if (paths.has(value.path)) return true;
    paths.add(value.path);
  }
  return false;
}

function strictBindingFailure(
  reasonCode: "strict_session_unavailable" | "strict_session_binding_unavailable",
  reason: string,
  contextFreshness: "untracked" | "missing" | "error"
): StrictCheckpointBinding {
  return { ok: false, reasonCode, reason, contextFreshness };
}
