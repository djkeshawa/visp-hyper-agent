import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { getActiveSession } from "../../core/session-manager.js";
import type { SessionRecord } from "../../core/types.js";
import { buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import { resolveProjectPath } from "./shared.js";

export function nextCommand(): Command {
  return new Command("next")
    .description("Print the next recommended action for the active session.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        console.log(
          [
            "BEGIN_VISP_NEXT_ACTION",
            "session_id: none",
            "next: run `visp-hyper start \"<goal>\"`",
            "END_VISP_NEXT_ACTION"
          ].join("\n")
        );
        return;
      }

      if (session.pipeline?.currentTaskId) {
        const graph = await loadTaskGraph(projectPath);
        if (!graph) {
          console.log("warning: pipeline state exists but the task graph could not be loaded.");
        } else {
          const task = currentTask(graph, session.pipeline);
          if (task) {
            const contextPackPath = await contextPackPathIfExists(projectPath, task.id);
            console.log(buildActionBlock(task, { sessionId: session.id, contextPackPath }));
            return;
          }
          console.log("warning: pipeline state exists but the current task is not in the task graph.");
        }
      }

      printLegacyNext(session);
    });
}

function printLegacyNext(session: SessionRecord): void {
  console.log(
    [
      "BEGIN_VISP_NEXT_ACTION",
      `session_id: ${session.id}`,
      `phase: ${session.phase}`,
      `goal: ${session.goal}`,
      "next: read .visp/hyper/current/agent-instructions.md and continue the implementation workflow",
      "END_VISP_NEXT_ACTION"
    ].join("\n")
  );
}

async function contextPackPathIfExists(projectPath: string, taskId: string): Promise<string | undefined> {
  const featureRoot = join(projectPath, ".visp", "features");
  let dirNames: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(featureRoot, { withFileTypes: true });
    dirNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return undefined;
  }
  for (const dirName of dirNames) {
    const relative = join(".visp", "features", dirName, "context", `${taskId}.context.json`);
    try {
      await stat(join(projectPath, relative));
      return relative;
    } catch {
      // try next feature directory
    }
  }
  return undefined;
}
