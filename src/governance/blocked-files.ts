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

/**
 * True for paths inside visp-hyper's own `.visp/hyper/` output tree (handoff,
 * state, context packs, telemetry). It is regenerated every run and is never
 * user-authored source, so it must not count as a scope violation or as work
 * the agent did. Canonical Kit artifacts elsewhere under `.visp/` are
 * deliberately NOT covered — those stay visible so they cannot be silently
 * tampered with. Tolerant of both separators for Windows paths.
 */
export function isHyperOwnedPath(file: string): boolean {
  const normalized = toPosixPath(file);
  return normalized === ".visp/hyper" || normalized.startsWith(".visp/hyper/");
}
