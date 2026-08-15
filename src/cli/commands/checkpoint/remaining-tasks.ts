/**
 * The cadence line printed after a successful save: what this feature still
 * owes, named at the moment the reader has just finished something.
 */

import { join } from "node:path";
import { readTextIfExists } from "../../../core/fs-utils.js";

/**
 * The cadence line: what this feature still owes after a save.
 *
 * Six evaluation rounds showed the same drift — the agent closes ONE task,
 * then batches the rest without saves, leaving implemented work forever
 * `pending`. Naming the remaining tasks at the exact moment a save succeeds
 * is the pull-back: the reader finishes one loop and is immediately handed
 * the next. Pure so the shape (short, capped, names not ids alone) is
 * pinned by a unit test.
 */
export function remainingTasksLine(
  tasks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>,
  justSavedId: string
): string | null {
  const remaining = tasks.filter(
    (task) =>
      task.id !== justSavedId && task.status !== "done" && task.status !== "verified"
  );
  if (remaining.length === 0) return null;
  const shown = remaining
    .slice(0, 4)
    .map((task) => `${task.id} (${task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title})`);
  const more = remaining.length > 4 ? ` (+${remaining.length - 4} more)` : "";
  return `remaining in this feature: ${shown.join(", ")}${more} — repeat plan → work → save for each`;
}

export async function printRemainingTasks(projectPath: string, justSavedId: string): Promise<void> {
  try {
    const statusText = await readTextIfExists(join(projectPath, ".visp", "status.json"));
    if (!statusText) return;
    const status = JSON.parse(statusText) as { activeFeaturePath?: string };
    if (typeof status.activeFeaturePath !== "string") return;
    const graphText = await readTextIfExists(
      join(projectPath, status.activeFeaturePath, "task-graph.json")
    );
    if (!graphText) return;
    const graph = JSON.parse(graphText) as {
      tasks?: Array<{ id?: string; title?: string; status?: string }>;
    };
    const tasks = (graph.tasks ?? []).filter(
      (task): task is { id: string; title: string; status: string } =>
        typeof task.id === "string" && typeof task.title === "string" && typeof task.status === "string"
    );
    const line = remainingTasksLine(tasks, justSavedId);
    if (line !== null) console.log(line);
  } catch {
    // The cadence line is advisory; a malformed artifact must not fail a save.
  }
}
