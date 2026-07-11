/**
 * Normalize a path to POSIX (forward-slash) separators. Node's `relative()` /
 * `join()` emit backslashes on Windows, but every downstream consumer in this
 * repo — blocked-path matching, git-diff scope comparison, artifact reference
 * matching, and emitted `ContextFile`/`ArtifactFile` paths — expects
 * forward-slash paths. Apply this at every `relative()`/`join()` emission point
 * so paths are platform-stable.
 */
export function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}
