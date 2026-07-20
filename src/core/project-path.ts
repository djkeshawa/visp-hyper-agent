import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { isBlockedPath } from "../governance/blocked-files.js";

export type ProjectFileMode = "read" | "write";

export type ResolvedProjectFile = {
  logicalPath: string;
  resolvedRelativePath: string;
  absolutePath: string;
  exists: boolean;
};

export class ProjectPathError extends Error {
  constructor(path: string, reason: string) {
    const printablePath = path.replaceAll("\0", "\\0");
    super(`Unsafe project path "${printablePath}": ${reason}.`);
    this.name = "ProjectPathError";
  }
}

/**
 * Resolve a project-relative file without trusting lexical containment alone.
 * Existing symlinks are followed only when their real target remains inside the
 * real project root. Missing write targets are resolved through their nearest
 * existing parent so a symlinked parent cannot redirect a later mkdir/write.
 */
export async function resolveProjectFile(
  projectPath: string,
  candidate: string,
  options: { mode: ProjectFileMode; blockedPaths?: string[] }
): Promise<ResolvedProjectFile> {
  const logicalPath = normalizeProjectRelativeFile(candidate);
  const rootPath = resolve(projectPath);
  const lexicalPath = resolve(rootPath, ...logicalPath.split("/"));
  if (!isContained(rootPath, lexicalPath)) {
    throw new ProjectPathError(candidate, "path escapes the project root");
  }

  const rootRealPath = await realpath(rootPath).catch(() => {
    throw new ProjectPathError(candidate, "project root is unavailable");
  });
  const rootInfo = await stat(rootRealPath).catch(() => {
    throw new ProjectPathError(candidate, "project root is unavailable");
  });
  if (!rootInfo.isDirectory()) {
    throw new ProjectPathError(candidate, "project root is not a directory");
  }

  const blockedPaths = (options.blockedPaths ?? []).map(toPortablePath);
  if (isBlockedPath(logicalPath, blockedPaths)) {
    throw new ProjectPathError(candidate, "path is blocked by project policy");
  }

  await validateExistingPrefixes(
    rootPath,
    rootRealPath,
    logicalPath.split("/"),
    blockedPaths,
    candidate
  );
  const resolved = await resolveExistingFileOrParent(lexicalPath, options.mode, candidate);
  if (!isContained(rootRealPath, resolved.absolutePath)) {
    throw new ProjectPathError(candidate, "resolved path escapes the project root");
  }

  const resolvedRelativePath = toPortablePath(relative(rootRealPath, resolved.absolutePath));
  if (resolvedRelativePath === "" || isBlockedPath(resolvedRelativePath, blockedPaths)) {
    throw new ProjectPathError(candidate, "resolved path is blocked by project policy");
  }

  return {
    logicalPath,
    resolvedRelativePath,
    absolutePath: resolved.absolutePath,
    exists: resolved.exists
  };
}

async function validateExistingPrefixes(
  rootPath: string,
  rootRealPath: string,
  segments: string[],
  blockedPaths: string[],
  candidate: string
): Promise<void> {
  let prefix = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    prefix = join(prefix, segments[index] ?? "");
    const prefixInfo = await lstatIfExists(prefix, candidate);
    if (!prefixInfo) {
      return;
    }

    const prefixRealPath = await realpath(prefix).catch(() => {
      throw new ProjectPathError(candidate, "path contains a dangling or unreadable symlink");
    });
    if (!isContained(rootRealPath, prefixRealPath)) {
      throw new ProjectPathError(
        candidate,
        "resolved path escapes the project root through an existing component"
      );
    }

    const prefixRelativePath = toPortablePath(relative(rootRealPath, prefixRealPath));
    if (prefixRelativePath !== "" && isBlockedPath(prefixRelativePath, blockedPaths)) {
      throw new ProjectPathError(
        candidate,
        "resolved path is blocked by project policy through an existing component"
      );
    }

    if (index < segments.length - 1) {
      const resolvedInfo = await stat(prefixRealPath).catch(() => {
        throw new ProjectPathError(candidate, "path component is unavailable");
      });
      if (!resolvedInfo.isDirectory()) {
        throw new ProjectPathError(candidate, "an intermediate path component is not a directory");
      }
    }
  }
}

function normalizeProjectRelativeFile(candidate: string): string {
  if (candidate.length === 0) {
    throw new ProjectPathError(candidate, "path is empty");
  }
  if (candidate.includes("\0")) {
    throw new ProjectPathError(candidate, "path contains a NUL byte");
  }

  const portable = toPortablePath(candidate);
  if (isAbsolute(candidate) || win32.isAbsolute(candidate) || /^[a-z]:/iu.test(portable)) {
    throw new ProjectPathError(candidate, "absolute paths are not allowed");
  }

  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) {
    throw new ProjectPathError(candidate, "path must identify a file");
  }
  if (segments.includes("..")) {
    throw new ProjectPathError(candidate, "parent traversal is not allowed");
  }
  return segments.join("/");
}

async function resolveExistingFileOrParent(
  lexicalPath: string,
  mode: ProjectFileMode,
  candidate: string
): Promise<{ absolutePath: string; exists: boolean }> {
  const targetInfo = await lstatIfExists(lexicalPath, candidate);
  if (targetInfo) {
    const targetRealPath = await realpath(lexicalPath).catch(() => {
      throw new ProjectPathError(candidate, "path is a dangling or unreadable symlink");
    });
    const targetStat = await stat(targetRealPath).catch(() => {
      throw new ProjectPathError(candidate, "path is unavailable");
    });
    if (!targetStat.isFile()) {
      throw new ProjectPathError(candidate, "path is not a regular file");
    }
    return { absolutePath: targetRealPath, exists: true };
  }

  if (mode === "read") {
    throw new ProjectPathError(candidate, "file does not exist");
  }

  const missingParts = [basename(lexicalPath)];
  let cursor = dirname(lexicalPath);
  while (!(await lstatIfExists(cursor, candidate))) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new ProjectPathError(candidate, "no existing project parent was found");
    }
    missingParts.unshift(basename(cursor));
    cursor = parent;
  }

  const parentRealPath = await realpath(cursor).catch(() => {
    throw new ProjectPathError(candidate, "parent is a dangling or unreadable symlink");
  });
  const parentStat = await stat(parentRealPath).catch(() => {
    throw new ProjectPathError(candidate, "parent is unavailable");
  });
  if (!parentStat.isDirectory()) {
    throw new ProjectPathError(candidate, "nearest existing parent is not a directory");
  }

  return { absolutePath: join(parentRealPath, ...missingParts), exists: false };
}

async function lstatIfExists(path: string, candidate: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw new ProjectPathError(candidate, "path could not be inspected");
  }
}

function isContained(rootPath: string, candidatePath: string): boolean {
  const relation = relative(rootPath, candidatePath);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
