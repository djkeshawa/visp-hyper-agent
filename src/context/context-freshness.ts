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
      finding: "context manifest is unreadable; regenerate with `visp-hyper run \"<goal>\"`",
      warnings: []
    };
  }

  const artifact = manifest.contextArtifact;
  if (!artifact) {
    return { status: "untracked", blocking: false, warnings: [] };
  }
  if (typeof artifact.path !== "string" || typeof artifact.hash !== "string" || artifact.hashAlgorithm !== "sha256") {
    return {
      status: "error",
      blocking: true,
      finding: "context manifest has invalid artifact freshness metadata; regenerate with `visp-hyper run \"<goal>\"`",
      warnings: []
    };
  }

  const absolutePath = resolve(projectPath, artifact.path);
  const rel = relative(projectPath, absolutePath);
  if (isAbsolute(rel) || rel.startsWith("..")) {
    return {
      status: "error",
      blocking: true,
      artifactPath: artifact.path,
      finding: `context artifact path escapes the project: ${artifact.path}`,
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
        artifactPath: artifact.path,
        expectedHash: artifact.hash,
        finding: `context artifact is missing since handoff: ${artifact.path}; regenerate with \`visp-hyper run "<goal>"\``,
        warnings: []
      };
    }
    return {
      status: "error",
      blocking: true,
      artifactPath: artifact.path,
      expectedHash: artifact.hash,
      finding: `context artifact could not be read: ${artifact.path}`,
      warnings: [error instanceof Error ? error.message : String(error)]
    };
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.hash) {
    return {
      status: "stale",
      blocking: true,
      artifactPath: artifact.path,
      expectedHash: artifact.hash,
      actualHash: actual,
      finding: `context artifact changed since handoff: ${artifact.path}; regenerate with \`visp-hyper run "<goal>"\``,
      warnings: []
    };
  }

  return {
    status: "current",
    blocking: false,
    artifactPath: artifact.path,
    expectedHash: artifact.hash,
    actualHash: actual,
    warnings: []
  };
}
