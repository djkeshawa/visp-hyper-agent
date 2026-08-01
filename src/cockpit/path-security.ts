import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { toPosixPath } from "../core/path-utils.js";

const SAFE_ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export type ContainedPathKind = "any" | "file" | "directory";

export type ContainedExistingPath = Readonly<{
  projectRealPath: string;
  absolutePath: string;
  relativePath: string;
}>;

export function isSafeCockpitRunId(value: string): boolean {
  return SAFE_ARTIFACT_SEGMENT.test(value) && value !== "." && value !== "..";
}

export function assertSafeCockpitRunId(value: string): string {
  if (!isSafeCockpitRunId(value)) {
    throw new TypeError("Run ID must be one safe path segment.");
  }
  return value;
}

export async function resolveContainedExistingPath(
  projectPath: string,
  repositoryRelativePath: string,
  kind: ContainedPathKind = "any"
): Promise<ContainedExistingPath> {
  if (!repositoryRelativePath || isAbsolute(repositoryRelativePath)) {
    throw new TypeError("Cockpit artifact path must be repository-relative.");
  }

  const lexicalProjectPath = resolve(projectPath);
  const lexicalCandidatePath = resolve(lexicalProjectPath, repositoryRelativePath);
  assertContained(lexicalProjectPath, lexicalCandidatePath);

  const projectRealPath = await realpath(lexicalProjectPath);
  const candidateFromProject = relative(lexicalProjectPath, lexicalCandidatePath);
  const canonicalCandidatePath = resolve(projectRealPath, candidateFromProject);
  assertContained(projectRealPath, canonicalCandidatePath);
  await assertNoSymbolicLinkComponents(projectRealPath, candidateFromProject);

  const absolutePath = await realpath(canonicalCandidatePath);
  assertContained(projectRealPath, absolutePath);
  if (absolutePath !== canonicalCandidatePath) {
    throw new TypeError("Cockpit artifact path must not traverse a symbolic link.");
  }

  const info = await lstat(absolutePath);
  if (kind === "file" && !info.isFile()) {
    throw new TypeError("Cockpit artifact path must resolve to a file.");
  }
  if (kind === "directory" && !info.isDirectory()) {
    throw new TypeError("Cockpit artifact path must resolve to a directory.");
  }

  return Object.freeze({
    projectRealPath,
    absolutePath,
    relativePath: toPosixPath(relative(projectRealPath, absolutePath))
  });
}

async function assertNoSymbolicLinkComponents(
  projectRealPath: string,
  candidateFromProject: string
): Promise<void> {
  if (candidateFromProject.length === 0) return;
  let currentPath = projectRealPath;
  for (const segment of candidateFromProject.split(sep)) {
    currentPath = resolve(currentPath, segment);
    if ((await lstat(currentPath)).isSymbolicLink()) {
      throw new TypeError("Cockpit artifact path must not traverse a symbolic link.");
    }
  }
}

function assertContained(rootPath: string, candidatePath: string): void {
  const pathFromRoot = relative(rootPath, candidatePath);
  const escapesRoot =
    pathFromRoot === ".." ||
    pathFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(pathFromRoot);
  if (escapesRoot) {
    throw new TypeError("Cockpit artifact path escapes the project root.");
  }
}
