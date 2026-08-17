// LC-135 — `visp save` must not report a clean close over a task Kit left open.
//
// The `result === "warnings"` inference this line was originally written from
// covers exactly one reason a reconcile skips the task-status write. Kit LC-107
// added `taskStatusUpdate`, which states the outcome and, when it was skipped,
// why. Hyper's reconcile mirror stripped that field, so every other reason —
// a dependency still open, a checklist item unattested, whatever Kit names in
// `skippedReason` — was reported as PASSED with nothing said.

import { describe, expect, it } from "vitest";

import { taskStatusLine } from "../../../../../src/cli/commands/checkpoint/task-status-line.js";

const passed = { taskId: "T001", verdict: "passed", acceptWarnings: false };

describe("the task_status line", () => {
  it("says the task is still open, with Kit's reason, when the status write was skipped", () => {
    const line = taskStatusLine({
      ...passed,
      reconcile: {
        success: true,
        result: "passed",
        taskStatusUpdate: {
          requested: true,
          performed: false,
          taskId: "T001",
          previousStatus: "pending",
          newStatus: null,
          skippedReason: "T001 depends on T000, which is not done"
        }
      }
    });

    expect(
      line,
      "a reconcile that passed while refusing to close the task is the exact state this line exists for"
    ).toContain("still open");
    expect(line, "Kit's reason verbatim; inventing a generic one is what hid this").toContain(
      "T001 depends on T000, which is not done"
    );
  });

  it("reports the status actually moving, which nothing used to say at all", () => {
    const line = taskStatusLine({
      ...passed,
      reconcile: {
        success: true,
        result: "passed",
        taskStatusUpdate: {
          requested: true,
          performed: true,
          taskId: "T001",
          previousStatus: "pending",
          newStatus: "done",
          skippedReason: null
        }
      }
    });

    expect(line).toBe("task_status: T001 pending → done");
  });

  it("still names the accept-warnings escape hatch when that is why it stayed open", () => {
    const line = taskStatusLine({
      ...passed,
      reconcile: {
        success: true,
        result: "warnings",
        taskStatusUpdate: {
          requested: true,
          performed: false,
          taskId: "T001",
          previousStatus: "pending",
          newStatus: null,
          skippedReason: "reconcile passed with warnings"
        }
      }
    });

    expect(line).toContain("still open");
    expect(line).toContain("visp save --task T001 --accept-warnings");
  });

  it("still says the task is open when Kit skips the write and gives no reason", () => {
    // Silence here would be the original defect exactly: PASSED printed over a
    // task that never moved. A missing reason is worth saying out loud — it is
    // a gap in what Kit reported, not permission to assume the task closed.
    const line = taskStatusLine({
      ...passed,
      reconcile: {
        success: true,
        result: "passed",
        taskStatusUpdate: { requested: true, performed: false, skippedReason: null }
      }
    });

    expect(line).toContain("still open");
    expect(line).toContain("gave no reason");
    expect(line, "there is nothing to accept, so offering --accept-warnings would misdirect").not.toContain(
      "--accept-warnings"
    );
  });

  it("says nothing when no status write was requested at all", () => {
    // A feature-level reconcile selects no task, so there is no task status to
    // report on and a line about one would be an invention.
    expect(
      taskStatusLine({
        ...passed,
        reconcile: {
          success: true,
          result: "passed",
          taskStatusUpdate: { requested: false, performed: false, taskId: null }
        }
      })
    ).toBeNull();
  });

  it("names the task and its states even when Kit sends them as null", () => {
    const line = taskStatusLine({
      ...passed,
      reconcile: {
        success: true,
        result: "passed",
        taskStatusUpdate: { requested: true, performed: true, taskId: null, previousStatus: null, newStatus: null }
      }
    });

    expect(line, "the task id falls back to the one being saved, never to 'null'").toBe(
      "task_status: T001 its previous status → closed"
    );
  });

  it("keeps the old sentence for a Kit that does not send the field", () => {
    // Backward compatibility in the direction that matters: a Kit older than
    // LC-107 sends no `taskStatusUpdate`, and the `result` inference is then
    // the best answer available. It must not regress to silence.
    const line = taskStatusLine({
      ...passed,
      reconcile: { success: true, result: "warnings" }
    });

    expect(line).toContain("reconcile passed with warnings");
    expect(line).toContain("visp save --task T001 --accept-warnings");
  });

  it("says nothing on a clean close by an older Kit", () => {
    expect(taskStatusLine({ ...passed, reconcile: { success: true, result: "passed" } })).toBeNull();
  });

  it("says nothing when the human already accepted the warnings", () => {
    expect(
      taskStatusLine({
        ...passed,
        acceptWarnings: true,
        reconcile: { success: true, result: "warnings" }
      })
    ).toBeNull();
  });

  it("stays quiet on a failed checkpoint, where the findings are the headline", () => {
    expect(
      taskStatusLine({
        ...passed,
        verdict: "failed",
        reconcile: {
          success: false,
          result: "failed",
          taskStatusUpdate: { requested: true, performed: false, skippedReason: "verify failed" }
        }
      })
    ).toBeNull();
  });

  it("says nothing when reconcile never ran", () => {
    expect(taskStatusLine({ ...passed, reconcile: null })).toBeNull();
  });
});
