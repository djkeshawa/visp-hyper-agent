import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  readonly version?: unknown;
};

const FALLBACK_VERSION = "0.0.0";

export function packageVersion(startUrl: string = import.meta.url): string {
  let current = dirname(fileURLToPath(startUrl));

  for (let depth = 0; depth <= 8; depth += 1) {
    try {
      const raw = readFileSync(join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as PackageJson;
      return typeof parsed.version === "string" && parsed.version.length > 0
        ? parsed.version
        : FALLBACK_VERSION;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  return FALLBACK_VERSION;
}
