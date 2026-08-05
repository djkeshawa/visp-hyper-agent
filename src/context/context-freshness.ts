import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { readTextIfExists, vispPath } from "../core/fs-utils.js";

export type ContextFreshnessStatus = "current" | "stale" | "missing" | "untracked" | "error";

export type ContextFreshness = {
  status: ContextFreshnessStatus;
  blocking: boolean;
  artifactPath?: string;
  expectedHash?: string;
  actualHash?: string;
  finding?: string;
  warnings: string[];
};

type ManifestLike = {
  contextArtifact?: {
    path?: unknown;
    hash?: unknown;
    hashAlgorithm?: unknown;
  };
  artifactProvenance?: unknown;
  freshnessWarnings?: unknown;
};

export async function checkContextFreshness(projectPath: string): Promise<ContextFreshness> {
  const manifestText = await readTextIfExists(vispPath(projectPath, "hyper", "current", "context-manifest.json"));
  if (!manifestText) {
    return { status: "untracked", blocking: false, warnings: ["context manifest is missing; freshness is untracked"] };
  }

  let manifest: ManifestLike;
  try {
    manifest = JSON.parse(manifestText) as ManifestLike;
  } catch {
    return {
      status: "error",
      blocking: true,
      finding: "context manifest is unreadable; regenerate with `visp work \"<goal>\"`",
      warnings: []
    };
  }
  const manifestWarnings = parseFreshnessWarnings(manifest.freshnessWarnings);

  const artifactChecks: FreshnessTarget[] = [];
  if (manifest.contextArtifact) {
    const parsed = parseTarget(manifest.contextArtifact, {
      kind: "context artifact",
      invalidFinding: "context manifest has invalid artifact freshness metadata; regenerate with `visp work \"<goal>\"`"
    });
    if ("error" in parsed) {
      return withWarnings(parsed.error, manifestWarnings);
    }
    artifactChecks.push(parsed.target);
  }

  if (manifest.artifactProvenance !== undefined) {
    if (!Array.isArray(manifest.artifactProvenance)) {
      return {
        status: "error",
        blocking: true,
        finding: "context manifest has invalid artifact provenance metadata; regenerate with `visp work \"<goal>\"`",
        warnings: manifestWarnings
      };
    }
    for (const entry of manifest.artifactProvenance) {
      const parsed = parseTarget(entry, {
        kind: "context provenance",
        invalidFinding: "context manifest has invalid artifact provenance metadata; regenerate with `visp work \"<goal>\"`"
      });
      if ("error" in parsed) {
        return withWarnings(parsed.error, manifestWarnings);
      }
      artifactChecks.push(parsed.target);
    }
  }

  if (artifactChecks.length === 0) {
    return { status: "untracked", blocking: false, warnings: manifestWarnings };
  }

  let lastCurrent: ContextFreshness | undefined;
  for (const target of artifactChecks) {
    const result = await checkTarget(projectPath, target);
    if (result.blocking) {
      return withWarnings(result, manifestWarnings);
    }
    lastCurrent = result;
  }

  return withWarnings(lastCurrent ?? { status: "current", blocking: false, warnings: [] }, manifestWarnings);
}

type FreshnessTarget = {
  kind: "context artifact" | "context provenance";
  path: string;
  hash: string;
  hashAlgorithm: "sha256";
  label?: string;
};

function parseTarget(
  value: unknown,
  options: { kind: FreshnessTarget["kind"]; invalidFinding: string }
): { target: FreshnessTarget } | { error: ContextFreshness } {
  if (!value || typeof value !== "object") {
    return {
      error: {
        status: "error",
        blocking: true,
        finding: options.invalidFinding,
        warnings: []
      }
    };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string" || typeof record.hash !== "string" || record.hashAlgorithm !== "sha256") {
    return {
      error: {
        status: "error",
        blocking: true,
        finding: options.invalidFinding,
        warnings: []
      }
    };
  }

  return {
    target: {
      kind: options.kind,
      path: record.path,
      hash: record.hash,
      hashAlgorithm: "sha256",
      ...(typeof record.label === "string" ? { label: record.label } : {})
    }
  };
}

async function checkTarget(projectPath: string, target: FreshnessTarget): Promise<ContextFreshness> {
  const absolutePath = resolve(projectPath, target.path);
  const rel = relative(projectPath, absolutePath);
  if (isAbsolute(rel) || rel.startsWith("..")) {
    return {
      status: "error",
      blocking: true,
      artifactPath: target.path,
      finding: `${target.kind} path escapes the project: ${target.path}`,
      warnings: []
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        status: "missing",
        blocking: true,
        artifactPath: target.path,
        expectedHash: target.hash,
        finding: `${target.kind} is missing since handoff: ${describeTarget(target)}; regenerate with \`visp work "<goal>"\``,
        warnings: []
      };
    }
    return {
      status: "error",
      blocking: true,
      artifactPath: target.path,
      expectedHash: target.hash,
      finding: `${target.kind} could not be read: ${describeTarget(target)}`,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== target.hash) {
    return {
      status: "stale",
      blocking: true,
      artifactPath: target.path,
      expectedHash: target.hash,
      actualHash: actual,
      finding: `${target.kind} changed since handoff: ${describeTarget(target)}; regenerate with \`visp work "<goal>"\``,
      warnings: []
    };
  }

  return {
    status: "current",
    blocking: false,
    artifactPath: target.path,
    expectedHash: target.hash,
    actualHash: actual,
    warnings: []
  };
}

function describeTarget(target: FreshnessTarget): string {
  return target.label ? `${target.label} at ${target.path}` : target.path;
}

function parseFreshnessWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function withWarnings(result: ContextFreshness, warnings: string[]): ContextFreshness {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings: [...warnings, ...result.warnings]
  };
}
