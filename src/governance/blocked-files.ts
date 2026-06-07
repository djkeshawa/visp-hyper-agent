export function isBlockedPath(path: string, blockedPatterns: string[]): boolean {
  return blockedPatterns.some((pattern) => {
    if (pattern.endsWith(".*")) {
      return path === pattern.slice(0, -2) || path.startsWith(`${pattern.slice(0, -2)}.`);
    }
    return path === pattern || path.startsWith(`${pattern}/`);
  });
}

