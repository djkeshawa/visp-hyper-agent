import type { ToolProfile } from "../core/types.js";
import type { NormalizedWorkflowAction } from "../kit/workflow-action-adapter.js";
import type {
  AssuranceProfile,
  RiskFactor,
  RiskLevel,
  TaskClass
} from "../kit/workflow-action-protocol.js";
import { CHEAP_TIER, type RoutingEvidenceCohort } from "./routing-engine.js";

export type RoutingTaskDescriptor = {
  id: string;
  taskClass: TaskClass | null;
  riskLevel: RiskLevel | null;
  riskFactors: readonly RiskFactor[] | null;
  assuranceProfile: AssuranceProfile | null;
  allowedFiles: readonly string[];
  expectedFiles?: readonly string[];
};

export function routingTaskFromAction(
  action: NormalizedWorkflowAction
): RoutingTaskDescriptor | null {
  if (!action.task) return null;
  return {
    id: action.task.id,
    taskClass: action.taskClass.state === "available" ? action.taskClass.value : null,
    riskLevel: action.risk.level.state === "available" ? action.risk.level.value : null,
    riskFactors: action.risk.factors.state === "available" ? action.risk.factors.value : null,
    assuranceProfile:
      action.assurance.profile.state === "available" ? action.assurance.profile.value : null,
    allowedFiles: action.scope.writablePaths,
    ...(action.scope.expectedPaths.state === "available"
      ? { expectedFiles: action.scope.expectedPaths.value }
      : {})
  };
}

export function routingCohortForTask(input: {
  host: ToolProfile;
  task: {
    allowedFiles?: readonly string[];
    expectedFiles?: readonly string[];
    assuranceProfile?: AssuranceProfile | null;
  };
  assuranceProfile?: AssuranceProfile | null;
  modelId?: string;
  modelVersion?: string | null;
}): RoutingEvidenceCohort {
  return {
    assuranceProfile:
      input.assuranceProfile !== undefined
        ? input.assuranceProfile
        : input.task.assuranceProfile ?? null,
    host: input.host,
    modelId: input.modelId ?? defaultModelId(input.host, CHEAP_TIER),
    modelVersion: input.modelVersion ?? null,
    projectPreset: inferProjectPreset([
      ...(input.task.allowedFiles ?? []),
      ...(input.task.expectedFiles ?? [])
    ])
  };
}

export function defaultModelId(host: ToolProfile, tier: string): string {
  if (host === "claude-code") {
    if (tier === "scout") return "sonnet";
    if (tier === "implementer") return "opus";
    if (tier === "coordinator") return "inherit";
  }
  return tier;
}

export function inferProjectPreset(paths: readonly string[]): string {
  const presets = new Set(
    paths
      .map((path) => path.toLowerCase().match(/(?:^|\/)[^/]+(\.[a-z0-9]+)$/u)?.[1])
      .map((extension) => extensionPreset(extension))
      .filter((preset): preset is string => preset !== null)
  );
  if (presets.size === 0) return "generic";
  if (presets.size === 1) return [...presets][0]!;
  return "mixed";
}

function extensionPreset(extension: string | undefined): string | null {
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".java":
    case ".kt":
      return "jvm";
    case ".cs":
      return "dotnet";
    case ".md":
    case ".mdx":
      return "documentation";
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
      return "configuration";
    default:
      return null;
  }
}
