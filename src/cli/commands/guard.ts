import { Command, Option } from "commander";
import { getActiveSession, readConfig } from "../../core/session-manager.js";
import type { PipelineGraphIdentity } from "../../core/types.js";
import { effectiveGraph } from "../../pipeline/adaptive-rules.js";
import {
  currentTask,
  loadTaskGraphByIdentity,
  validatePipelineState
} from "../../pipeline/pipeline-engine.js";
import {
  attributableChangedFiles,
  checkScope,
  collectChangedFiles,
  type ChangedFilesMode,
  type ScopeViolation
} from "../../governance/scope-guard.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import type { KitStatus, WorkflowActionV2 } from "../../kit/kit-schemas.js";
import { resolveProjectPath } from "./shared.js";

type GuardOptions = {
  staged?: boolean;
  all?: boolean;
  base?: string;
  feature?: string;
  task?: string;
};

type ScopeAssertion = { feature: string; taskId: string };

type ScopeAssertionResult =
  | { ok: true; assertion: ScopeAssertion | null }
  | { ok: false; reasonCode: string; reason: string };

type LocalScopeResult =
  | {
      ok: true;
      scope: {
        feature: string | null;
        taskId: string | null;
        allowedFiles?: string[];
        forbiddenFiles?: string[];
      };
    }
  | { ok: false; reasonCode: string; reason: string };

export function guardCommand(): Command {
  return new Command("guard")
    .description("Mechanically enforce task scope against changed files (for git hooks).")
    .addOption(new Option("--staged", "Check staged changes (default)."))
    .addOption(new Option("--all", "Check the union of staged and working-tree changes."))
    .addOption(new Option("--base <ref>", "Check changes between <ref>...HEAD."))
    .addOption(new Option("--feature <feature>", "Assert the exact active feature (for CI)."))
    .addOption(new Option("--task <task-id>", "Assert the exact active task (for CI)."))
    .action(async function (this: Command, options: GuardOptions) {
      const projectPath = resolveProjectPath(this);
      const assertionResult = parseScopeAssertion(options);
      if (!assertionResult.ok) {
        stopInconclusive(assertionResult.reasonCode, assertionResult.reason);
        return;
      }
      const assertion = assertionResult.assertion;

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

      const config = await readConfig(projectPath);
      let scope: GuardScope;
      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const diagnostic = await bridge.nextActionDiagnostic();
        if (!diagnostic.ok) {
          for (const warning of bridge.warnings) console.warn(`warning: ${warning}`);
          stopInconclusive(diagnostic.reasonCode, diagnostic.reason);
          return;
        }
        const action = diagnostic.value;
        if (action.verdict !== "ready") {
          stopInconclusive(
            `workflow_action_${action.verdict}`,
            action.findings.join("; ") || `Kit workflow action verdict is ${action.verdict}.`,
            action.nextCommand
          );
          return;
        }
        if (!action.taskId) {
          stopInconclusive(
            "workflow_action_missing_task",
            "Kit returned a ready workflow action without a task id.",
            action.nextCommand
          );
          return;
        }
        const refreshedKit = await detectVisp(projectPath);
        if (refreshedKit.state !== "healthy") {
          stopInconclusive(
            refreshedKit.state === "configured-unhealthy"
              ? refreshedKit.reasonCode
              : "kit_status_refresh_unavailable",
            refreshedKit.state === "configured-unhealthy"
              ? refreshedKit.reason
              : "Kit authority disappeared after the workflow action was read.",
            action.nextCommand
          );
          return;
        }
        const authorityFailure = stableKitAuthority(kit.status, refreshedKit.status, action);
        if (authorityFailure) {
          stopInconclusive(
            authorityFailure.reasonCode,
            authorityFailure.reason,
            action.nextCommand
          );
          return;
        }
        scope = kitScope(action, refreshedKit.status, config.blockedPaths);
      } else {
        const localScope = await resolveScope(projectPath);
        if (!localScope.ok) {
          stopInconclusive(localScope.reasonCode, localScope.reason);
          return;
        }
        scope = {
          authority: "local",
          feature: localScope.scope.feature,
          taskId: localScope.scope.taskId,
          allowedFiles: localScope.scope.allowedFiles,
          blockedPaths: [
            ...new Set([...config.blockedPaths, ...(localScope.scope.forbiddenFiles ?? [])])
          ]
        };
      }

      const assertionFailure = checkScopeAssertion(scope, assertion);
      if (assertionFailure) {
        stopInconclusive(assertionFailure.reasonCode, assertionFailure.reason);
        return;
      }

      const inventory = await collectChangedFiles(projectPath, mode);
      if (!inventory.ok || inventory.warnings.length > 0) {
        stopInconclusive(
          "changed_files_unavailable",
          inventory.warnings.join("; ") || "The Git evidence inventory is incomplete."
        );
        return;
      }
      const files = attributableChangedFiles(inventory.files);
      const violations = checkGuardScope(files, scope);

      const blocked = violations.length > 0;
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
      lines.push(`status: ${blocked ? "BLOCKED" : "PASSED"}`);
      lines.push("END_VISP_GUARD_RESULT");

      console.log(lines.join("\n"));

      if (blocked) {
        process.exitCode = 1;
      }
    });
}

function describeMode(mode: ChangedFilesMode): string {
  return mode.mode === "base" ? `base ${mode.baseRef}` : mode.mode;
}

type GuardScope = {
  authority: "kit" | "local";
  feature: string | null;
  taskId: string | null;
  allowedFiles?: string[];
  blockedPaths: string[];
};

function kitScope(
  action: WorkflowActionV2,
  status: KitStatus,
  configuredBlockedPaths: string[]
): GuardScope {
  return {
    authority: "kit",
    feature: featureKey(status.activeFeature),
    taskId: action.taskId,
    allowedFiles: action.writablePaths,
    blockedPaths: [...new Set([...configuredBlockedPaths, ...action.forbiddenPaths])]
  };
}

function featureKey(feature: { id: string; slug?: string } | null | undefined): string | null {
  if (!feature?.id) {
    return null;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}

function stableKitAuthority(
  initial: KitStatus,
  refreshed: KitStatus,
  action: WorkflowActionV2
): { reasonCode: string; reason: string } | null {
  const initialFeature = featureKey(initial.activeFeature);
  const refreshedFeature = featureKey(refreshed.activeFeature);
  const initialTask = initial.activeTask?.id ?? null;
  const refreshedTask = refreshed.activeTask?.id ?? null;
  if (!initialFeature || !refreshedFeature || !initialTask || !refreshedTask) {
    return {
      reasonCode: "kit_scope_identity_missing",
      reason: "Kit status did not expose a complete feature/task identity around the workflow action."
    };
  }
  if (
    initialFeature !== refreshedFeature ||
    initialTask !== refreshedTask ||
    action.taskId !== refreshedTask
  ) {
    return {
      reasonCode: "workflow_action_scope_mismatch",
      reason:
        `Kit scope changed while guard resolved authority ` +
        `(${initialFeature}/${initialTask} -> ${refreshedFeature}/${refreshedTask}; action ${action.taskId ?? "none"}).`
    };
  }
  return null;
}

function pipelineFeatureKey(identity: PipelineGraphIdentity): string | null {
  if (!identity.featureId) {
    return null;
  }
  return identity.featureSlug
    ? `${identity.featureId}-${identity.featureSlug}`
    : identity.featureId;
}

function parseScopeAssertion(options: GuardOptions): ScopeAssertionResult {
  const hasFeature = options.feature !== undefined;
  const hasTask = options.task !== undefined;
  if (!hasFeature && !hasTask) {
    return { ok: true, assertion: null };
  }
  if (!hasFeature || !hasTask) {
    return {
      ok: false,
      reasonCode: "guard_scope_arguments_incomplete",
      reason: "--feature and --task must be supplied together."
    };
  }
  if (!isExactScopeValue(options.feature!) || !isExactScopeValue(options.task!)) {
    return {
      ok: false,
      reasonCode: "guard_scope_arguments_invalid",
      reason: "--feature and --task must be non-empty, trimmed, single-line values."
    };
  }
  return { ok: true, assertion: { feature: options.feature!, taskId: options.task! } };
}

function isExactScopeValue(value: string): boolean {
  return value.length > 0 && value === value.trim() && !/[\r\n]/u.test(value);
}

function checkScopeAssertion(
  scope: GuardScope,
  assertion: ScopeAssertion | null
): { reasonCode: string; reason: string } | null {
  if (!assertion) {
    return null;
  }
  if (!scope.taskId) {
    return {
      reasonCode: "guard_scope_unavailable",
      reason: "No active task scope is available to satisfy the explicit feature/task assertion."
    };
  }
  if (!scope.feature) {
    return {
      reasonCode: "guard_feature_unavailable",
      reason: "The active task scope has no feature identity to compare with --feature."
    };
  }
  if (scope.feature !== assertion.feature) {
    return {
      reasonCode: "guard_feature_mismatch",
      reason: `Configured feature ${assertion.feature} does not match active feature ${scope.feature}.`
    };
  }
  if (scope.taskId !== assertion.taskId) {
    return {
      reasonCode: "guard_task_mismatch",
      reason: `Configured task ${assertion.taskId} does not match active task ${scope.taskId}.`
    };
  }
  return null;
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

function stopInconclusive(reasonCode: string, reason: string, nextAllowedCommand?: string): void {
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

/**
 * Resolve only the graph pinned by the active session. A genuinely absent
 * session/pipeline remains compatible with blocked-path-only local guarding;
 * an ambiguous or stale persisted pipeline cannot authorize changes.
 */
async function resolveScope(projectPath: string): Promise<LocalScopeResult> {
  const session = await getActiveSession(projectPath);
  const pipeline = session?.pipeline;
  if (!session || !pipeline) {
    return {
      ok: true,
      scope: { feature: null, taskId: null }
    };
  }

  if (!pipeline.graphIdentity) {
    return {
      ok: false,
      reasonCode: "pipeline_identity_missing",
      reason: "The saved pipeline predates exact graph and task identity."
    };
  }

  const loaded = await loadTaskGraphByIdentity(
    projectPath,
    pipeline.graphIdentity,
    pipeline.syntheticTasks
  );
  if (!loaded.ok) {
    return loaded;
  }

  const graph = effectiveGraph(loaded.graph, pipeline);
  const validation = validatePipelineState(graph, pipeline, { sessionId: session.id });
  if (!validation.ok) {
    return validation;
  }

  if (!pipeline.currentTaskId) {
    return {
      ok: false,
      reasonCode: "guard_scope_unavailable",
      reason: "The persisted pipeline has no active task scope to enforce."
    };
  }

  const task = currentTask(graph, pipeline);
  if (!task) {
    return {
      ok: false,
      reasonCode: "pipeline_current_task_missing",
      reason: "The active task is not present in the pinned task graph."
    };
  }

  return {
    ok: true,
    scope: {
      feature: pipelineFeatureKey(pipeline.graphIdentity),
      taskId: task.id,
      allowedFiles: task.allowedFiles,
      forbiddenFiles: task.forbiddenFiles
    }
  };
}
