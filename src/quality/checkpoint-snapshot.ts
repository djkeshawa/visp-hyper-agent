import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { collectChangedFiles } from "../governance/scope-guard.js";

const checkpointSnapshotFileSchema = z.object({
  path: z.string(),
  exists: z.boolean(),
  hash: z.string().nullable()
});

const checkpointSnapshotSchema = z.object({
  version: z.literal("0.1"),
  checkpointAt: z.string(),
  sessionId: z.string(),
  goal: z.string(),
  taskId: z.string().optional(),
  files: z.array(checkpointSnapshotFileSchema),
  warnings: z.array(z.string())
});

export type CheckpointSnapshotFile = z.infer<typeof checkpointSnapshotFileSchema>;
export type CheckpointSnapshot = z.infer<typeof checkpointSnapshotSchema>;

export type CheckpointDelta = {
  checkpointAt: string | null;
  addedSinceCheckpoint: string[];
  changedSinceCheckpoint: string[];
  clearedSinceCheckpoint: string[];
  unchangedSinceCheckpoint: string[];
  warnings: string[];
};

export async function createCheckpointSnapshot(
  projectPath: string,
  input: { sessionId: string; goal: string; taskId?: string }
): Promise<CheckpointSnapshot> {
  const { files, warnings } = await collectSnapshotFiles(projectPath);
  return {
    version: "0.1",
    checkpointAt: new Date().toISOString(),
    sessionId: input.sessionId,
    goal: input.goal,
    taskId: input.taskId,
    files,
    warnings
  };
}

export async function writeCheckpointSnapshot(
  projectPath: string,
  snapshot: CheckpointSnapshot
): Promise<void> {
  await writeText(snapshotPath(projectPath), `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function readCheckpointSnapshot(
  projectPath: string
): Promise<{ snapshot: CheckpointSnapshot | null; warnings: string[] }> {
  const raw = await readTextIfExists(snapshotPath(projectPath));
  if (raw === undefined) {
    return { snapshot: null, warnings: [] };
  }

  const { value, warnings } = parseJsonStore(
    raw,
    checkpointSnapshotSchema.nullable(),
    () => null,
    "checkpoint-snapshot.json",
    "no checkpoint snapshot"
  );
  return { snapshot: value, warnings };
}

export async function compareCurrentToCheckpoint(projectPath: string): Promise<CheckpointDelta> {
  const [{ snapshot, warnings: snapshotWarnings }, current] = await Promise.all([
    readCheckpointSnapshot(projectPath),
    collectSnapshotFiles(projectPath)
  ]);
  const warnings = [...snapshotWarnings, ...current.warnings];

  if (!snapshot) {
    return emptyDelta(null, warnings);
  }

  const previousByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const currentByPath = new Map(current.files.map((file) => [file.path, file]));
  const addedSinceCheckpoint: string[] = [];
  const changedSinceCheckpoint: string[] = [];
  const clearedSinceCheckpoint: string[] = [];
  const unchangedSinceCheckpoint: string[] = [];

  for (const [path, currentFile] of currentByPath) {
    const previous = previousByPath.get(path);
    if (!previous) {
      addedSinceCheckpoint.push(path);
      continue;
    }
    if (sameSnapshotFile(previous, currentFile)) {
      unchangedSinceCheckpoint.push(path);
    } else {
      changedSinceCheckpoint.push(path);
    }
  }

  for (const path of previousByPath.keys()) {
    if (!currentByPath.has(path)) {
      clearedSinceCheckpoint.push(path);
    }
  }

  return {
    checkpointAt: snapshot.checkpointAt,
    addedSinceCheckpoint: addedSinceCheckpoint.sort(),
    changedSinceCheckpoint: changedSinceCheckpoint.sort(),
    clearedSinceCheckpoint: clearedSinceCheckpoint.sort(),
    unchangedSinceCheckpoint: unchangedSinceCheckpoint.sort(),
    warnings
  };
}

export function emptyDelta(checkpointAt: string | null = null, warnings: string[] = []): CheckpointDelta {
  return {
    checkpointAt,
    addedSinceCheckpoint: [],
    changedSinceCheckpoint: [],
    clearedSinceCheckpoint: [],
    unchangedSinceCheckpoint: [],
    warnings
  };
}

async function collectSnapshotFiles(
  projectPath: string
): Promise<{ files: CheckpointSnapshotFile[]; warnings: string[] }> {
  const changed = await collectChangedFiles(projectPath, { mode: "all" });
  const warnings = [...changed.warnings];
  const files = await Promise.all(
    changed.files
      .map(normalizePath)
      .filter((path) => !isHyperRuntimePath(path))
      .sort()
      .map(async (path) => {
        const result = await hashWorkspaceFile(projectPath, path);
        if (result.warning) {
          warnings.push(result.warning);
        }
        return {
          path,
          exists: result.exists,
          hash: result.hash
        };
      })
  );
  return { files, warnings };
}

async function hashWorkspaceFile(
  projectPath: string,
  path: string
): Promise<{ exists: boolean; hash: string | null; warning?: string }> {
  try {
    const content = await readFile(join(projectPath, path));
    return {
      exists: true,
      hash: createHash("sha256").update(content).digest("hex")
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, hash: null };
    }
    return {
      exists: true,
      hash: null,
      warning: `Unable to hash changed file ${path}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function sameSnapshotFile(left: CheckpointSnapshotFile, right: CheckpointSnapshotFile): boolean {
  if (left.exists !== right.exists) {
    return false;
  }
  if (!left.exists && !right.exists) {
    return true;
  }
  return left.hash !== null && right.hash !== null && left.hash === right.hash;
}

function snapshotPath(projectPath: string): string {
  return vispPath(projectPath, "hyper", "current", "checkpoint-snapshot.json");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isHyperRuntimePath(path: string): boolean {
  return path.startsWith(".visp/hyper/");
}
