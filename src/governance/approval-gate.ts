import type { KitTask } from "../kit/kit-schemas.js";

/**
 * Enforce the approval class Kit declared on a task (P8-05).
 *
 * **Hyper reads, it does not decide.** Kit derives `approvalClass` from
 * reversibility, blast radius, and risk; this module obeys the declared value.
 * Deriving it here would make Hyper a second authority on permission, which the
 * workspace boundary forbids in Kit-backed strict mode.
 *
 * **Absent is not permission.** A task graph written before P8-05 carries no
 * declaration. That is treated as `checkpointed` — not `autonomous` — so an
 * older artifact cannot buy more freedom than a current one by omitting a field.
 * The cost is a checkpoint nobody asked for; the alternative is silently
 * granting autonomy on a task nobody classified.
 *
 * **Confidence never appears here.** No calibration figure, routing suggestion,
 * or model score is an input to this function, and none may become one. A
 * well-calibrated agent may be consulted less often; it may never be allowed to
 * touch more. That is the invariant Phase 8 is most likely to erode by accident,
 * so the gate takes a task and nothing else.
 */

export type ApprovalClass = "autonomous" | "checkpointed" | "approval_required";

/** Used when a task carries no declaration. Deliberately not `autonomous`. */
export const UNDECLARED_APPROVAL_CLASS: ApprovalClass = "checkpointed";

export type ApprovalDecision = {
  readonly approvalClass: ApprovalClass;
  /** Whether Hyper may proceed without a human decision. */
  readonly mayProceedAutonomously: boolean;
  /** Whether a recoverable checkpoint must exist before the action. */
  readonly requiresCheckpoint: boolean;
  /** Why, in terms a person reading a transcript can act on. */
  readonly reason: string;
  /** True when the class came from the default rather than the task. */
  readonly declared: boolean;
};

const VALID: ReadonlySet<string> = new Set<ApprovalClass>([
  "autonomous",
  "checkpointed",
  "approval_required"
]);

/**
 * Decide what a host must do before acting on this task.
 *
 * Fails closed on an unrecognised value: a class this build does not know is
 * treated as `approval_required`, never ignored. An unknown string is more
 * likely a newer Kit declaring something stricter than a typo meaning
 * "anything goes".
 */
export function approvalDecisionFor(task: Pick<KitTask, "approvalClass" | "reversibility" | "blastRadius">): ApprovalDecision {
  const raw = task.approvalClass;

  if (raw === undefined) {
    return {
      approvalClass: UNDECLARED_APPROVAL_CLASS,
      mayProceedAutonomously: false,
      requiresCheckpoint: true,
      declared: false,
      reason:
        "task declares no approval class; treated as checkpointed because an omitted declaration is not consent"
    };
  }

  if (!VALID.has(raw)) {
    return {
      approvalClass: "approval_required",
      mayProceedAutonomously: false,
      requiresCheckpoint: true,
      declared: true,
      reason: `unrecognised approval class "${String(raw)}"; failing closed to approval_required`
    };
  }

  const approvalClass = raw as ApprovalClass;
  if (approvalClass === "approval_required") {
    return {
      approvalClass,
      mayProceedAutonomously: false,
      requiresCheckpoint: true,
      declared: true,
      reason:
        task.reversibility === "irreversible"
          ? "the change cannot be undone; a human decides"
          : task.blastRadius === "external"
            ? "the change reaches outside this repository; a human decides"
            : "Kit requires human approval for this task"
    };
  }

  if (approvalClass === "checkpointed") {
    return {
      approvalClass,
      mayProceedAutonomously: true,
      requiresCheckpoint: true,
      declared: true,
      reason: "reversible only by compensation, or high risk; checkpoint before acting"
    };
  }

  return {
    approvalClass,
    mayProceedAutonomously: true,
    requiresCheckpoint: false,
    declared: true,
    reason: "reversible, confined to this task, and not high risk"
  };
}
