import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command, Option } from "commander";
import { readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { getActiveSession } from "../../core/session-manager.js";
import type { SessionRecord } from "../../core/types.js";
import { requiredReads, renderHandoff } from "../../handoff/handoff-protocol.js";
import { buildActionBlock, currentTask, loadTaskGraph } from "../../pipeline/pipeline-engine.js";
import { contextPackPathIfExists, resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

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
  readonly changedFiles: readonly string[];
  readonly warnings: readonly string[];
  readonly nextCommand: string;
  readonly handoff?: string;
  readonly actionBlock?: string;
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
      warnings: ["No active Visp Hyper session."],
      nextCommand: "visp-hyper run \"<goal>\""
    };
  }

  const [readStatuses, artifactStatuses, checkpointText, changed] = await Promise.all([
    fileStatuses(projectPath, requiredReads),
    fileStatuses(projectPath, artifactPaths),
    readTextIfExists(vispPath(projectPath, "hyper", "current", "checkpoints.md")),
    changedFiles(projectPath)
  ]);
  const actionBlock = await currentActionBlock(projectPath, session);
  const handoff = await handoffText(projectPath, session);
  const warnings: string[] = [];
  if (readStatuses.some((status) => !status.present)) {
    warnings.push("One or more required read files are missing; run `visp-hyper run \"<goal>\"` to regenerate them.");
  }
  if (!actionBlock && session.pipeline?.currentTaskId) {
    warnings.push("Pipeline state exists, but the current task graph could not be resolved.");
  }
  warnings.push(...changed.warnings);

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
    latestCheckpoint: latestCheckpoint(checkpointText),
    changedFiles: changed.files,
    warnings,
    nextCommand: session.pipeline?.currentTaskId
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
    "",
    "required_reads:",
    ...summary.requiredReads.map((status) => `  - ${status.path}: ${status.present ? "present" : "missing"}`),
    "",
    "artifacts:",
    ...summary.artifacts.map((status) => `  - ${status.path}: ${status.present ? "present" : "missing"}`),
    "",
    "changed_files:",
    ...(summary.changedFiles.length > 0 ? summary.changedFiles.map((file) => `  - ${file}`) : ["  - none"])
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
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: projectPath });
    for (const file of splitLines(stdout)) {
      files.add(file);
    }
  } catch (error) {
    warnings.push(`Unable to read current git diff: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: projectPath });
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
  return buildActionBlock(task, { sessionId: session.id, contextPackPath });
}
