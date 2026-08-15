/**
 * The human-readable checkpoint record written to disk.
 */

import { gitOutput } from "../../../core/git.js";
import { readTextIfExists, vispPath, writeText } from "../../../core/fs-utils.js";
import { createCheckpointSnapshot, writeCheckpointSnapshot } from "../../../quality/checkpoint-snapshot.js";

export async function writeCheckpointMarkdown(
  projectPath: string,
  sessionId: string,
  goal: string,
  taskId?: string
): Promise<void> {
  // A project with no commits yet has no resolvable HEAD. That is an ordinary
  // first-run state, so the diff stat degrades to a note instead of throwing
  // out of the whole checkpoint.
  const [stat, snapshot] = await Promise.all([
    gitOutput(projectPath, ["diff", "--stat", "HEAD"]),
    createCheckpointSnapshot(projectPath, { sessionId, goal, taskId })
  ]);
  const diffStat = stat.ok
    ? stat.stdout.trim() || "_No diff._"
    : `_Diff stat unavailable: ${stat.reason}._`;
  const files = snapshot.files.map((file) => file.path);
  const content = [
    `## Checkpoint ${snapshot.checkpointAt}`,
    "",
    `Session: ${sessionId}`,
    `Goal: ${goal}`,
    ...(taskId ? [`Task: ${taskId}`] : []),
    "",
    "## Git Diff Stat",
    "",
    diffStat,
    "",
    "## Changed Files",
    "",
    ...(files.length > 0 ? files.map((file) => `- ${file}`) : ["_No changed files._"]),
    ...(snapshot.warnings.length > 0
      ? [
          "",
          "## Snapshot Warnings",
          "",
          ...snapshot.warnings.map((warning) => `- ${warning}`)
        ]
      : []),
    ""
  ].join("\n");
  const path = vispPath(projectPath, "hyper", "current", "checkpoints.md");
  const previous = await readTextIfExists(path);
  await writeText(path, previous ? `${previous.trimEnd()}\n\n${content}` : `# Checkpoints\n\n${content}`);
  await writeCheckpointSnapshot(projectPath, snapshot);
}
