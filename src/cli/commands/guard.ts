import { Command, Option } from "commander";
import { getActiveSession, readConfig } from "../../core/session-manager.js";
import { loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import {
  checkScope,
  collectChangedFiles,
  type ChangedFilesMode,
  type ScopeViolation
} from "../../governance/scope-guard.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import type { NormalizedWorkflowAction } from "../../kit/workflow-action-adapter.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../kit/workflow-action-renderer.js";
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

      // Explicit precedence: base > all > staged.
      const mode: ChangedFilesMode =
        options.base !== undefined
          ? { mode: "base", baseRef: options.base }
          : options.all
            ? { mode: "all" }
            : { mode: "staged" };

      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        stopInconclusive(kit.reasonCode, kit.reason);
        return;
      }

      let scope: GuardScope;
      let actionFrame: string | undefined;
      let actionVerdict: NormalizedWorkflowAction["verdict"] | undefined;
      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const contractDiagnostic = await bridge.integrationContractDiagnostic();
        printBridgeWarnings(bridge);
        if (!contractDiagnostic.ok) {
          stopInconclusive(contractDiagnostic.reasonCode, contractDiagnostic.reason);
          return;
        }

        const actionDiagnostic = await bridge.nextCanonicalActionDiagnostic(
          "auto",
          contractDiagnostic.value
        );
        printBridgeWarnings(bridge);
        if (!actionDiagnostic.ok) {
          stopInconclusive(actionDiagnostic.reasonCode, actionDiagnostic.reason);
          return;
        }
        const action = actionDiagnostic.value;
        actionFrame = renderHyperActionFrame(toHyperActionEnvelope(action));
        actionVerdict = action.verdict;
        scope = kitScope(action);
      } else {
        const config = await readConfig(projectPath);
        const localScope = await resolveScope(projectPath);
        scope = {
          authority: "local",
          taskId: localScope?.taskId ?? null,
          allowedFiles: localScope?.allowedFiles,
          blockedPaths: config.blockedPaths
        };
      }

      const { files, warnings } = await collectChangedFiles(projectPath, mode);
      const inconclusive = scope.authority === "kit" && warnings.length > 0;
      const violations = inconclusive ? [] : checkGuardScope(files, scope);

      const blocked = violations.length > 0;
      const status = inconclusive ? "INCONCLUSIVE" : blocked ? "BLOCKED" : "PASSED";
      const lines: string[] = [
        "BEGIN_VISP_GUARD_RESULT",
        `scope: ${scope.taskId ?? "none"}`,
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
      if (inconclusive) {
        lines.push("reason_code: changed_files_unavailable");
        lines.push(`reason: ${singleLine(warnings.join("; "))}`);
      }
      lines.push(`status: ${status}`);
      lines.push("END_VISP_GUARD_RESULT");

      if (scope.authority === "local") {
        for (const warning of warnings) {
          console.log(`warning: ${warning}`);
        }
      }
      console.log(lines.join("\n"));
      if (actionFrame !== undefined) {
        console.log("");
        console.log(actionFrame);
      }

      // Kit-less behavior degrades open on Git uncertainty. Configured Kit is
      // successful only when both the mechanical check and action are ready.
      if (blocked || (scope.authority === "kit" && (inconclusive || actionVerdict !== "ready"))) {
        process.exitCode = 1;
      }
    });
}

function describeMode(mode: ChangedFilesMode): string {
  return mode.mode === "base" ? `base ${mode.baseRef}` : mode.mode;
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

type GuardScope = {
  authority: "kit" | "local";
  taskId: string | null;
  allowedFiles?: string[];
  blockedPaths: string[];
};

function kitScope(action: NormalizedWorkflowAction): GuardScope {
  return {
    authority: "kit",
    taskId: action.task?.id ?? null,
    allowedFiles: [...action.scope.writablePaths],
    blockedPaths: [...action.scope.forbiddenPaths]
  };
}

function checkGuardScope(files: string[], scope: GuardScope): ScopeViolation[] {
  const violations = checkScope(files, {
    allowedFiles: scope.allowedFiles,
    blockedPaths: scope.blockedPaths
  });
  if (scope.authority !== "kit" || (scope.allowedFiles?.length ?? 0) > 0) {
    return violations;
  }

  const alreadyBlocked = new Set(violations.map((violation) => violation.file));
  return [
    ...violations,
    ...files
      .filter((file) => !alreadyBlocked.has(file))
      .map((file): ScopeViolation => ({ file, rule: "outside-allowed" }))
  ];
}

function stopInconclusive(
  reasonCode: string,
  reason: string,
  nextAllowedCommand?: string
): void {
  console.log(
    renderKitAuthorityStop({
      status: "INCONCLUSIVE",
      reasonCode,
      reason,
      nextAllowedCommand
    })
  );
  process.exitCode = 1;
}

function printBridgeWarnings(bridge: KitCommandBridge): void {
  for (const warning of bridge.warnings) {
    console.warn(`warning: ${warning}`);
  }
  bridge.warnings.length = 0;
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
