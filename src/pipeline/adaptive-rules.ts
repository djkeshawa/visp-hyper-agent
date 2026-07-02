import type { KitTask, KitTaskGraph } from "../kit/kit-schemas.js";
import type { AdaptiveDecisionRecord, PipelineState } from "../core/types.js";
import type { FailurePattern } from "../memory/failure-patterns.js";

// Deterministic adaptation thresholds (named constants, routing-engine style).
// A task that fails checkpoint this many times in a row gets a scoped
// remediation task injected before it:
export const REMEDIATION_AFTER_FAILURES = 2;
// At most this many remediation injections per failing task; beyond that the
// only adaptive response is an escalation directive:
export const MAX_REMEDIATIONS_PER_TASK = 1;
// A streak this long always escalates (also reached when the injection cap is
// already spent):
export const ESCALATION_AFTER_FAILURES = 3;
// A failure pattern seen at least this often marks a known failure mode and
// tightens evidence requirements:
export const STRICT_EVIDENCE_MIN_PATTERN_OCCURRENCES = 2;

const MAX_FINDINGS_IN_DESCRIPTION = 6;
const MAX_FINDING_LENGTH = 200;
const MAX_KNOWN_FAILURE_MODES = 5;
const HIGH_RISK_LEVELS = new Set(["high", "critical"]);

const REMEDIATION_PREFIX = "R-";

export type AdaptiveDecision =
  | { action: "none" }
  | { action: "inject-remediation"; rule: string; remediationTask: KitTask }
  | { action: "escalation-directive"; rule: string; reason: string };

/**
 * Trailing `checkpoint-failed` streak for `taskId`: counted from the end of
 * stepHistory, considering only entries for that task, and broken by its
 * first non-failure entry (a pass resets the streak; other tasks' steps in
 * between do not).
 */
export function consecutiveFailures(state: PipelineState, taskId: string): number {
  let count = 0;
  for (let index = state.stepHistory.length - 1; index >= 0; index -= 1) {
    const step = state.stepHistory[index]!;
    if (step.taskId !== taskId) {
      continue;
    }
    if (step.action === "checkpoint-failed") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

/** True when `taskId` was itself injected as a remediation task. */
export function isInjectedTask(state: PipelineState, taskId: string): boolean {
  return (state.injectedTasks ?? []).some((task) => task.id === taskId);
}

function remediationCountFor(state: PipelineState, taskId: string): number {
  const prefix = `${REMEDIATION_PREFIX}${taskId}-`;
  return (state.injectedTasks ?? []).filter((task) => task.id.startsWith(prefix)).length;
}

/**
 * Deterministic remediation task scoped to the failing task: same file scope
 * and validation commands, description built verbatim from the checkpoint
 * findings (sorted, deduped, truncated) — no generation of any kind.
 */
export function synthesizeRemediationTask(
  failing: KitTask,
  findings: readonly string[],
  ordinal: number
): KitTask {
  const cleaned = [...new Set(findings.map((finding) => finding.replace(/\s+/gu, " ").trim()).filter(Boolean))]
    .sort()
    .slice(0, MAX_FINDINGS_IN_DESCRIPTION)
    .map((finding) => (finding.length > MAX_FINDING_LENGTH ? `${finding.slice(0, MAX_FINDING_LENGTH)}…` : finding));
  const description = [
    `Resolve the findings that failed checkpoint for ${failing.id}:`,
    ...(cleaned.length > 0 ? cleaned.map((finding) => `- ${finding}`) : ["- checkpoint failed without detailed findings"])
  ].join("\n");

  return {
    id: `${REMEDIATION_PREFIX}${failing.id}-${ordinal}`,
    title: `Remediate ${failing.id}`,
    description,
    dependsOn: [],
    ...(failing.allowedFiles ? { allowedFiles: failing.allowedFiles } : {}),
    ...(failing.forbiddenFiles ? { forbiddenFiles: failing.forbiddenFiles } : {}),
    ...(failing.validationCommands ? { validationCommands: failing.validationCommands } : {}),
    status: "pending",
    // Never lower the risk class: remediation inherits the failing task's.
    ...(failing.riskLevel ? { riskLevel: failing.riskLevel } : {})
  };
}

/**
 * Decide the deterministic adaptive response to a failed checkpoint. Pure:
 * same state + task + findings always yield the same decision. Remediation
 * tasks never get remediations of their own — a failing remediation escalates.
 */
export function decideAdaptiveAction(input: {
  state: PipelineState;
  task: KitTask;
  findings: readonly string[];
}): AdaptiveDecision {
  const failures = consecutiveFailures(input.state, input.task.id);
  if (failures < REMEDIATION_AFTER_FAILURES) {
    return { action: "none" };
  }

  if (isInjectedTask(input.state, input.task.id)) {
    return {
      action: "escalation-directive",
      rule: `remediation-failures>=${REMEDIATION_AFTER_FAILURES}`,
      reason: `remediation task ${input.task.id} is itself failing; a stronger tier should take over`
    };
  }

  const remediations = remediationCountFor(input.state, input.task.id);
  if (failures >= ESCALATION_AFTER_FAILURES || remediations >= MAX_REMEDIATIONS_PER_TASK) {
    return {
      action: "escalation-directive",
      rule:
        failures >= ESCALATION_AFTER_FAILURES
          ? `consecutive-failures>=${ESCALATION_AFTER_FAILURES}`
          : `remediation-cap>=${MAX_REMEDIATIONS_PER_TASK}`,
      reason: `${failures} consecutive checkpoint failures on ${input.task.id}; escalate to the strongest tier`
    };
  }

  return {
    action: "inject-remediation",
    rule: `consecutive-failures>=${REMEDIATION_AFTER_FAILURES}`,
    remediationTask: synthesizeRemediationTask(input.task, input.findings, remediations + 1)
  };
}

/**
 * Apply an adaptive decision to the pipeline state. Pure and immutable: the
 * input state is never mutated. Injection records the remediation task, points
 * `currentTaskId` at it, and logs both the decision and a `task-injected`
 * step; escalation only logs (routing quarantine fires independently).
 */
export function applyAdaptiveDecision(
  state: PipelineState,
  decision: AdaptiveDecision,
  failingTaskId: string,
  now: string
): PipelineState {
  if (decision.action === "none") {
    return state;
  }

  if (decision.action === "inject-remediation") {
    const remediationId = decision.remediationTask.id;
    const record: AdaptiveDecisionRecord = {
      at: now,
      taskId: failingTaskId,
      rule: decision.rule,
      action: "inject-remediation",
      detail: remediationId
    };
    return {
      ...state,
      currentTaskId: remediationId,
      taskIds: insertBefore(state.taskIds, failingTaskId, remediationId),
      injectedTasks: [...(state.injectedTasks ?? []), decision.remediationTask],
      decisionLog: [...(state.decisionLog ?? []), record],
      stepHistory: [
        ...state.stepHistory,
        { taskId: remediationId, action: "task-injected", at: now, detail: `remediates ${failingTaskId}` }
      ]
    };
  }

  const record: AdaptiveDecisionRecord = {
    at: now,
    taskId: failingTaskId,
    rule: decision.rule,
    action: "escalation-directive",
    detail: decision.reason
  };
  return {
    ...state,
    decisionLog: [...(state.decisionLog ?? []), record],
    stepHistory: [
      ...state.stepHistory,
      { taskId: failingTaskId, action: "escalation-issued", at: now, detail: decision.reason }
    ]
  };
}

/**
 * In-memory merge of the loaded graph and the session's injected remediation
 * tasks: each failing task additionally depends on its remediations so
 * ordering sequences them first. The disk graph is never mutated; the input
 * graph object is returned untouched when nothing was injected.
 */
export function effectiveGraph(graph: KitTaskGraph, state: PipelineState | undefined): KitTaskGraph {
  const injected = state?.injectedTasks ?? [];
  if (injected.length === 0) {
    return graph;
  }
  const injectedIds = new Set(injected.map((task) => task.id));
  const baseTasks = graph.tasks
    .filter((task) => !injectedIds.has(task.id))
    .map((task) => {
      const prefix = `${REMEDIATION_PREFIX}${task.id}-`;
      const remediations = injected.map((entry) => entry.id).filter((id) => id.startsWith(prefix));
      const missing = remediations.filter((id) => !task.dependsOn.includes(id));
      return missing.length > 0 ? { ...task, dependsOn: [...task.dependsOn, ...missing] } : task;
    });
  return { ...graph, tasks: [...baseTasks, ...injected] };
}

/**
 * Evidence requirements for a task, tightened by risk level and recurring
 * failure patterns. Context freshness already fails closed (stale/missing/
 * error all block), so the gap strict mode closes is *vacuous verify*: a
 * strict task may not pass verify without at least one real validation
 * command. Only ever tightens the gate.
 */
export function evidenceRequirements(
  task: KitTask | null,
  patterns: readonly FailurePattern[]
): { strictEvidence: boolean; knownFailureModes: string[] } {
  const highRisk = task?.riskLevel !== undefined && HIGH_RISK_LEVELS.has(task.riskLevel);
  const recurring = patterns.some((pattern) => pattern.occurrences >= STRICT_EVIDENCE_MIN_PATTERN_OCCURRENCES);
  const knownFailureModes = [...new Set(patterns.flatMap((pattern) => pattern.findings))].slice(
    0,
    MAX_KNOWN_FAILURE_MODES
  );
  return { strictEvidence: highRisk || recurring, knownFailureModes };
}

/**
 * Deterministic adaptation text block, printed after (never inside)
 * BEGIN_VISP_CHECKPOINT_RESULT. Advisory in the same sense as the routing
 * block: it tells the coding agent what the pipeline decided and what to run.
 */
export function renderAdaptationBlock(failingTaskId: string, decision: AdaptiveDecision): string | null {
  if (decision.action === "none") {
    return null;
  }
  const lines = ["BEGIN_VISP_ADAPTATION", `task: ${failingTaskId}`, `rule: ${decision.rule}`];
  if (decision.action === "inject-remediation") {
    lines.push("action: inject-remediation");
    lines.push(`remediation_task: ${decision.remediationTask.id}`);
    lines.push(
      `reason: repeated checkpoint failures; the findings were scoped into ${decision.remediationTask.id}`
    );
    lines.push(
      `instruction: Complete ${decision.remediationTask.id} first, then re-attempt ${failingTaskId}. Run \`visp-hyper next\` for the action block.`
    );
  } else {
    lines.push("action: escalation-directive");
    lines.push(`reason: ${decision.reason}`);
    lines.push(
      `instruction: Have the strongest available tier re-attempt ${failingTaskId}, then re-run \`visp-hyper checkpoint --task ${failingTaskId}\`.`
    );
  }
  lines.push("END_VISP_ADAPTATION");
  return lines.join("\n");
}

function insertBefore(ids: readonly string[], anchor: string, id: string): string[] {
  if (ids.includes(id)) {
    return [...ids];
  }
  const index = ids.indexOf(anchor);
  if (index === -1) {
    return [...ids, id];
  }
  return [...ids.slice(0, index), id, ...ids.slice(index)];
}
