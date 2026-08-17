/**
 * The one line telling the reader whether the task they just saved is closed.
 *
 * `visp save` prints a PASSED verdict from Kit's verify/review/reconcile
 * evidence. That verdict is about the WORK, and it has twice been read as being
 * about the TASK. The first time, a passed-with-warnings reconcile left the
 * task open by design and nothing said so; `result` was mirrored and this line
 * was written from it. The second time (LC-135) was the same defect one layer
 * down: `result` is a proxy for the status write, and any other reason for
 * skipping it — Kit's `skippedReason` — still read as a clean close.
 *
 * Kit answers this directly in `taskStatusUpdate`, so that is what is read when
 * it is there. The `result` inference stays as the fallback for a Kit that does
 * not send it, and produces exactly the sentence it produced before.
 *
 * PRESENTATION ONLY. Nothing here changes a verdict, an exit code or a
 * workflow state — Kit decides whether the task is complete, and this reports
 * what Kit decided.
 */

import type { KitReconcileSummary } from "../../../kit/kit-schemas.js";

export function taskStatusLine(input: {
  readonly taskId: string;
  readonly verdict: string;
  readonly reconcile: KitReconcileSummary | null | undefined;
  readonly acceptWarnings: boolean;
}): string | null {
  // A failed checkpoint is already the headline, and the task is plainly not
  // closed. Adding a second sentence about it would only compete with the
  // findings the reader has to act on.
  if (input.verdict !== "passed") return null;

  const update = input.reconcile?.taskStatusUpdate;
  const closeHint = `Review the warnings, then close with: visp save --task ${input.taskId} --accept-warnings`;
  const warningsPending = input.reconcile?.result === "warnings" && !input.acceptWarnings;

  if (update !== undefined && update !== null) {
    if (update.performed === true) {
      const from = update.previousStatus ?? "its previous status";
      const to = update.newStatus ?? "closed";
      return `task_status: ${update.taskId ?? input.taskId} ${from} → ${to}`;
    }
    if (update.requested === true) {
      // Kit's own reason, verbatim, because it names causes this file cannot
      // enumerate — and inventing a generic one is what hid the defect.
      const reason =
        update.skippedReason ??
        (warningsPending
          ? "reconcile passed with warnings, and accepting them is a human call"
          : "Kit did not perform the status write and gave no reason");
      return `task_status: still open — ${reason}.${warningsPending ? ` ${closeHint}` : ""}`;
    }
    return null;
  }

  // No `taskStatusUpdate`: a Kit older than LC-107. Unchanged behaviour.
  return warningsPending
    ? `task_status: still open — reconcile passed with warnings, and accepting them is a human call. ${closeHint}`
    : null;
}
