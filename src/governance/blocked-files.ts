import { toPosixPath } from "../core/path-utils.js";

/**
 * Defense-in-depth: the input path is normalized to forward slashes before
 * matching so a Windows backslash path (e.g. `node_modules\\foo`) is still
 * filtered even if an upstream emission point forgot to normalize.
 */
export function isBlockedPath(path: string, blockedPatterns: string[]): boolean {
  const normalized = toPosixPath(path);
  return blockedPatterns.some((pattern) => {
    if (pattern.endsWith(".*")) {
      return normalized === pattern.slice(0, -2) || normalized.startsWith(`${pattern.slice(0, -2)}.`);
    }
    return normalized === pattern || normalized.startsWith(`${pattern}/`);
  });
}
