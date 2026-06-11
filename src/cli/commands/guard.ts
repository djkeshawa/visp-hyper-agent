import { Command, Option } from "commander";
import { getActiveSession, readConfig } from "../../core/session-manager.js";
import { loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import {
  checkScope,
  collectChangedFiles,
  type ChangedFilesMode
} from "../../governance/scope-guard.js";
import { resolveProjectPath } from "./shared.js";

type GuardOptions = { staged?: boolean; all?: boolean; base?: string };

export function guardCommand(): Command {
  return new Command("guard")
    .description("Mechanically enforce task scope against changed files (for git hooks).")
    .addOption(new Option("--staged", "Check staged changes (default)."))
    .addOption(new Option("--all", "Check the union of staged and working-tree changes."))
    .addOption(new Option("--base <ref>", "Check changes between <ref>...HEAD."))
    .action(async function (this: Command, options: GuardOptions) {
      const projectPath = resolveProjectPath(this);
      const config = await readConfig(projectPath);

      // Explicit precedence: base > all > staged.
      const mode: ChangedFilesMode =
        options.base !== undefined
          ? { mode: "base", baseRef: options.base }
          : options.all
            ? { mode: "all" }
            : { mode: "staged" };

      const scope = await resolveScope(projectPath);
      const { files, warnings } = await collectChangedFiles(projectPath, mode);
      const violations = checkScope(files, {
        allowedFiles: scope?.allowedFiles,
        blockedPaths: config.blockedPaths
      });

      const blocked = violations.length > 0;
      const lines: string[] = [
        "BEGIN_VISP_GUARD_RESULT",
        `scope: ${scope?.taskId ?? "none"}`,
        `checked: ${files.length} file(s) (${describeMode(mode)})`,
        "violations:"
      ];
      if (violations.length === 0) {
        lines.push("  - none");
      } else {
        for (const violation of violations) {
          lines.push(
            `  - ${violation.file}: ${
              violation.rule === "blocked-path" ? "blocked path" : "outside allowed files"
            }`
          );
        }
      }
      lines.push(`status: ${blocked ? "BLOCKED" : "PASSED"}`);
      lines.push("END_VISP_GUARD_RESULT");

      for (const warning of warnings) {
        console.log(`warning: ${warning}`);
      }
      console.log(lines.join("\n"));

      // Degrade open: only REAL violations block. A broken git read (warnings)
      // must not lock ordinary commits out.
      if (blocked) {
        process.exitCode = 1;
      }
    });
}

function describeMode(mode: ChangedFilesMode): string {
  return mode.mode === "base" ? `base ${mode.baseRef}` : mode.mode;
}

/**
 * Resolve the active task's scope (id + allowed files). Any missing link in the
 * chain (no session, no pipeline, no current task, no matching task) yields
 * `null` so the caller falls back to "scope: none" — blocked paths still apply.
 * Mirrors checkpoint's disk-graph-then-synthetic-tasks resolution.
 */
async function resolveScope(
  projectPath: string
): Promise<{ taskId: string; allowedFiles?: string[] } | null> {
  const session = await getActiveSession(projectPath);
  const currentTaskId = session?.pipeline?.currentTaskId;
  if (!session || !currentTaskId) {
    return null;
  }

  const syntheticTasks = session.pipeline?.syntheticTasks;
  const graph =
    (await loadTaskGraph(projectPath)) ??
    (syntheticTasks && syntheticTasks.length > 0 ? { tasks: syntheticTasks } : null);
  if (!graph) {
    return null;
  }

  const task = graph.tasks.find((entry) => entry.id === currentTaskId);
  if (!task) {
    return null;
  }

  return { taskId: task.id, allowedFiles: task.allowedFiles };
}
