import type { ContextFile, ContextManifest, HandoffResource, SessionRecord } from "../core/types.js";
import { requiredReads, requiredResourceReads } from "../handoff/handoff-protocol.js";
import type { FailurePattern } from "../memory/failure-patterns.js";

export type BuildContextManifestInput = {
  session: SessionRecord;
  contextSource: string;
  taskId?: string;
  contextArtifact?: ContextManifest["contextArtifact"];
  contextFiles: ContextFile[];
  validationCommands: string[];
  blockedPaths: string[];
  failurePatterns: FailurePattern[];
  nextCommand?: string;
};

export function buildContextManifest(input: BuildContextManifestInput): ContextManifest {
  return {
    version: "0.1",
    sessionId: input.session.id,
    goal: input.session.goal,
    toolProfile: input.session.tool,
    generatedAt: input.session.updatedAt,
    contextSource: input.contextSource,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.contextArtifact ? { contextArtifact: input.contextArtifact } : {}),
    requiredReads: [...requiredReads],
    requiredResources: cloneResources(requiredResourceReads),
    selectedFiles: input.contextFiles.map((file) => ({
      path: file.path,
      reason: file.reason,
      hasContent: file.content !== undefined && file.content.length > 0,
      ...(file.sourceHash ? { sourceHash: file.sourceHash } : {}),
      ...(file.sourceHashAlgorithm ? { sourceHashAlgorithm: file.sourceHashAlgorithm } : {}),
      ...(file.sourceHashSource ? { sourceHashSource: file.sourceHashSource } : {})
    })),
    validationCommands: [...input.validationCommands],
    blockedPaths: [...input.blockedPaths],
    failurePatterns: input.failurePatterns.map((pattern) => ({
      id: pattern.id,
      taskId: pattern.taskId,
      taskClass: pattern.taskClass,
      source: pattern.source,
      occurrences: pattern.occurrences,
      relatedFiles: [...pattern.relatedFiles],
      findings: pattern.findings.slice(0, 5)
    })),
    nextCommand: input.nextCommand ?? "visp-hyper next"
  };
}

export function renderContextManifest(manifest: ContextManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function cloneResources(resources: readonly HandoffResource[]): HandoffResource[] {
  return resources.map((resource) => ({ ...resource }));
}
