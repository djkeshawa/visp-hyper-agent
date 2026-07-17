import { Command, Option } from "commander";
import { checkContextFreshness } from "../../context/context-freshness.js";
import type { ContextFreshness, ContextFreshnessStatus } from "../../context/context-freshness.js";
import { execFileResolved } from "../../core/executable-resolver.js";
import { readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { getActiveSession } from "../../core/session-manager.js";
import type { SessionRecord } from "../../core/types.js";
import { requiredReads, renderHandoff } from "../../handoff/handoff-protocol.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import type { WorkflowActionV2 } from "../../kit/kit-schemas.js";
import { buildActionBlock, currentTask, loadTaskGraph, readySet } from "../../pipeline/pipeline-engine.js";
import { compareCurrentToCheckpoint, emptyDelta, type CheckpointDelta } from "../../quality/checkpoint-snapshot.js";
import { contextPackPathIfExists, resolveProjectPath } from "./shared.js";

type ResumeOptions = {
  readonly json?: boolean;
};

type ResumeFileStatus = {
  readonly path: string;
  readonly present: boolean;
};

type ResumeSummary = {
  readonly success: boolean;
  readonly projectPath: string;
  readonly sessionId: string | null;
  readonly goal?: string;
  readonly phase?: string;
  readonly currentTaskId?: string | null;
  readonly completedTasks?: readonly string[];
  readonly requiredReads: readonly ResumeFileStatus[];
  readonly artifacts: readonly ResumeFileStatus[];
  readonly latestCheckpoint: string | null;
  readonly contextFreshness?: ResumeContextFreshness;
  readonly changedFiles: readonly string[];
  readonly checkpointDelta: CheckpointDelta;
  readonly warnings: readonly string[];
  readonly nextCommand: string;
  readonly handoff?: string;
  readonly actionBlock?: string;
};

type ResumeContextFreshness = {
  readonly status: ContextFreshnessStatus;
  readonly blocking: boolean;
  readonly artifactPath?: string;
  readonly finding?: string;
  readonly warnings: readonly string[];
};

const artifactPaths = [
  ".visp/hyper/current/checkpoints.md",
  ".visp/hyper/current/review-report.md",
  ".visp/prompts/visp-hyper-handoff.prompt.md"
];

export function resumeCommand(): Command {
  return new Command("resume")
    .description("Reprint the current handoff plus delta context after a context reset.")
    .addOption(new Option("--json", "Print a machine-readable resume summary."))
    .action(async function (this: Command, options: ResumeOptions) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        stopInconclusive(kit.reasonCode, kit.reason);
        return;
      }
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

        console.log(options.json ? JSON.stringify(action, null, 2) : formatKitResume(action));
        return;
      }

      const summary = await buildResumeSummary(projectPath);

      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log(formatResumeSummary(summary));
      }

      if (!summary.success) {
        process.exitCode = 1;
      }
    });
}

function formatKitResume(action: WorkflowActionV2): string {
  return [
    "BEGIN_VISP_RESUME",
    "authority: kit",
    `task: ${action.taskId ?? "none"}`,
    `next: ${action.nextCommand}`,
    "END_VISP_RESUME",
    "",
    "BEGIN_VISP_WORKFLOW_ACTION_V2",
    JSON.stringify(action),
    "END_VISP_WORKFLOW_ACTION_V2"
  ].join("\n");
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

export async function buildResumeSummary(projectPath: string): Promise<ResumeSummary> {
  const session = await getActiveSession(projectPath);
  if (!session) {
    return {
      success: false,
      projectPath,
      sessionId: null,
      requiredReads: [],
      artifacts: [],
      latestCheckpoint: null,
      changedFiles: [],
      checkpointDelta: emptyDelta(),
      warnings: ["No active Visp Hyper session."],
      nextCommand: "visp-hyper run \"<goal>\""
    };
  }

  const [readStatuses, artifactStatuses, checkpointText, changed, checkpointDelta, contextFreshness] = await Promise.all([
    fileStatuses(projectPath, requiredReads),
    fileStatuses(projectPath, artifactPaths),
    readTextIfExists(vispPath(projectPath, "hyper", "current", "checkpoints.md")),
    changedFiles(projectPath),
    compareCurrentToCheckpoint(projectPath),
    checkContextFreshness(projectPath)
  ]);
  const actionBlock = await currentActionBlock(projectPath, session);
  const handoff = await handoffText(projectPath, session);
  const warnings: string[] = [];
  const latest = latestCheckpoint(checkpointText);
  if (readStatuses.some((status) => !status.present)) {
    warnings.push("One or more required read files are missing; run `visp-hyper run \"<goal>\"` to regenerate them.");
  }
  if (!actionBlock && session.pipeline?.currentTaskId) {
    warnings.push("Pipeline state exists, but the current task graph could not be resolved.");
  }
  if (latest && !checkpointDelta.checkpointAt) {
    warnings.push("Latest checkpoint has no machine-readable snapshot; run `visp-hyper checkpoint` again to enable exact resume deltas.");
  }
  if (contextFreshness.blocking) {
    warnings.push(contextFreshness.finding ?? `Context freshness is ${contextFreshness.status}; regenerate the handoff.`);
  }
  warnings.push(...contextFreshness.warnings);
  warnings.push(...changed.warnings);
  warnings.push(...checkpointDelta.warnings);

  return {
    success: true,
    projectPath,
    sessionId: session.id,
    goal: session.goal,
    phase: session.phase,
    currentTaskId: session.pipeline?.currentTaskId ?? null,
    completedTasks: session.pipeline?.completed ?? [],
    requiredReads: readStatuses,
    artifacts: artifactStatuses,
    latestCheckpoint: latest,
    contextFreshness: summarizeContextFreshness(contextFreshness),
    changedFiles: changed.files,
    checkpointDelta,
    warnings,
    nextCommand: contextFreshness.blocking
      ? `visp-hyper run "${session.goal}"`
      : session.pipeline?.currentTaskId
      ? `visp-hyper checkpoint --task ${session.pipeline.currentTaskId}`
      : "visp-hyper next",
    handoff,
    actionBlock: actionBlock ?? undefined
  };
}

function formatResumeSummary(summary: ResumeSummary): string {
  if (!summary.success) {
    return [
      "BEGIN_VISP_RESUME",
      "session_id: none",
      `next: ${summary.nextCommand}`,
      "END_VISP_RESUME"
    ].join("\n");
  }

  const lines = [
    "BEGIN_VISP_RESUME",
    `session_id: ${summary.sessionId}`,
    `goal: ${summary.goal}`,
    `phase: ${summary.phase}`,
    `current_task: ${summary.currentTaskId ?? "none"}`,
    `latest_checkpoint: ${summary.latestCheckpoint ?? "none"}`,
    `context_freshness: ${formatContextFreshness(summary.contextFreshness)}`,
    "",
    "required_reads:",
    ...summary.requiredReads.map((status) => `  - ${status.path}: ${status.present ? "present" : "missing"}`),
    "",
    "artifacts:",
    ...summary.artifacts.map((status) => `  - ${status.path}: ${status.present ? "present" : "missing"}`),
    "",
    "changed_files:",
    ...(summary.changedFiles.length > 0 ? summary.changedFiles.map((file) => `  - ${file}`) : ["  - none"]),
    "",
    "checkpoint_delta:",
    `  snapshot: ${summary.checkpointDelta.checkpointAt ?? "missing"}`,
    "  added_since_checkpoint:",
    ...formatFileList(summary.checkpointDelta.addedSinceCheckpoint, "    "),
    "  changed_since_checkpoint:",
    ...formatFileList(summary.checkpointDelta.changedSinceCheckpoint, "    "),
    "  cleared_since_checkpoint:",
    ...formatFileList(summary.checkpointDelta.clearedSinceCheckpoint, "    "),
    "  unchanged_since_checkpoint:",
    ...formatFileList(summary.checkpointDelta.unchangedSinceCheckpoint, "    ")
  ];

  if (summary.completedTasks && summary.completedTasks.length > 0) {
    lines.push("", "completed_tasks:", ...summary.completedTasks.map((task) => `  - ${task}`));
  }

  if (summary.warnings.length > 0) {
    lines.push("", "warnings:", ...summary.warnings.map((warning) => `  - ${warning}`));
  }

  lines.push("", `next: ${summary.nextCommand}`, "END_VISP_RESUME");

  if (summary.handoff) {
    lines.push("", summary.handoff);
  }
  if (summary.actionBlock) {
    lines.push("", summary.actionBlock);
  }

  return lines.join("\n");
}

function summarizeContextFreshness(freshness: ContextFreshness): ResumeContextFreshness {
  return {
    status: freshness.status,
    blocking: freshness.blocking,
    ...(freshness.artifactPath ? { artifactPath: freshness.artifactPath } : {}),
    ...(freshness.finding ? { finding: freshness.finding } : {}),
    warnings: [...freshness.warnings]
  };
}

function formatContextFreshness(freshness: ResumeContextFreshness | undefined): string {
  if (!freshness) {
    return "unknown";
  }
  const parts: string[] = [freshness.status];
  if (freshness.blocking && freshness.finding) {
    parts.push(`- ${freshness.finding}`);
  }
  if (freshness.warnings.length > 0) {
    parts.push(`warnings: ${freshness.warnings.join("; ")}`);
  }
  return parts.join(" ");
}

function formatFileList(files: readonly string[], indent: string): string[] {
  return files.length > 0 ? files.map((file) => `${indent}- ${file}`) : [`${indent}- none`];
}

async function fileStatuses(projectPath: string, paths: readonly string[]): Promise<ResumeFileStatus[]> {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      present: (await readTextIfExists(resolveVispPath(projectPath, path))) !== undefined
    }))
  );
}

function resolveVispPath(projectPath: string, path: string): string {
  const withoutPrefix = path.startsWith(".visp/") ? path.slice(".visp/".length) : path;
  return vispPath(projectPath, ...withoutPrefix.split("/"));
}

async function changedFiles(projectPath: string): Promise<{ files: string[]; warnings: string[] }> {
  const files = new Set<string>();
  const warnings: string[] = [];
  try {
    const { stdout } = await execFileResolved("git", ["diff", "--name-only", "HEAD"], { cwd: projectPath });
    for (const file of splitLines(stdout)) {
      files.add(file);
    }
  } catch (error) {
    warnings.push(`Unable to read current git diff: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const { stdout } = await execFileResolved("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectPath });
    for (const file of splitLines(stdout)) {
      files.add(file);
    }
  } catch (error) {
    warnings.push(`Unable to read untracked files: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { files: [...files].sort(), warnings };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function latestCheckpoint(content: string | undefined): string | null {
  if (!content) {
    return null;
  }
  const matches = [...content.matchAll(/^## Checkpoint (.+)$/gmu)];
  return matches.length > 0 ? matches[matches.length - 1]?.[1] ?? null : null;
}

async function handoffText(projectPath: string, session: SessionRecord): Promise<string> {
  return (await readTextIfExists(vispPath(projectPath, "prompts", "visp-hyper-handoff.prompt.md")))?.trimEnd() ??
    renderHandoff(session);
}

async function currentActionBlock(projectPath: string, session: SessionRecord): Promise<string | null> {
  const currentTaskId = session.pipeline?.currentTaskId;
  if (!currentTaskId || !session.pipeline) {
    return null;
  }
  const syntheticTasks = session.pipeline.syntheticTasks;
  const graph =
    (await loadTaskGraph(projectPath)) ??
    (syntheticTasks && syntheticTasks.length > 0 ? { tasks: syntheticTasks } : null);
  if (!graph) {
    return null;
  }
  const task = currentTask(graph, session.pipeline);
  if (!task) {
    return null;
  }
  const contextPackPath = await contextPackPathIfExists(projectPath, task.id);
  const concurrentWith = readySet(graph, task.id, session.pipeline.completed);
  return buildActionBlock(task, { sessionId: session.id, contextPackPath, concurrentWith });
}
