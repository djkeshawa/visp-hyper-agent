import type { ContextFile, KitArtifacts, MemoryPack, SessionRecord } from "../core/types.js";

export function renderSession(session: SessionRecord): string {
  return [
    `# Visp Hyper Session ${session.id}`,
    "",
    `Goal: ${session.goal}`,
    `Tool: ${session.tool}`,
    `Phase: ${session.phase}`,
    `Created: ${session.createdAt}`,
    "",
    "## Relevant Files",
    "",
    ...session.relevantFiles.map((file) => `- ${file}`),
    ""
  ].join("\n");
}

export function renderContextPack(files: ContextFile[], kit: KitArtifacts): string {
  return [
    "# Context Pack",
    "",
    "## Selected Files",
    "",
    ...files.flatMap((file) => [
      `### ${file.path}`,
      "",
      `Reason: ${file.reason}`,
      "",
      file.content ? fenced(file.content) : "_Content omitted or unreadable._",
      ""
    ]),
    "## Visp-Kit Artifacts",
    "",
    ...renderWarnings(kit.warnings),
    kit.constitution ? `Constitution: present - ${kit.constitution.summary}` : "Constitution: missing",
    `Rules: ${kit.rules.length}`,
    ...kit.rules.map((file) => `- ${file.path}: ${file.summary}`),
    `Specs: ${kit.specs.length}`,
    ...kit.specs.map((file) => `- ${file.path}: ${file.summary}`),
    `Plans: ${kit.plans.length}`,
    ...kit.plans.map((file) => `- ${file.path}: ${file.summary}`),
    `Tasks: ${kit.tasks.length}`,
    ...kit.tasks.map((file) => `- ${file.path}: ${file.summary}`),
    ""
  ].join("\n");
}

export function renderMemoryPack(memory: MemoryPack): string {
  if (memory.files.length === 0) {
    return ["# Memory Pack", "", ...renderWarnings(memory.warnings), "No local Visp memory files found yet.", ""].join("\n");
  }
  return [
    "# Memory Pack",
    "",
    ...renderWarnings(memory.warnings),
    ...memory.files.flatMap((file) => [`## ${file.path}`, "", `Summary: ${file.summary}`, "", fenced(file.content), ""])
  ].join("\n");
}

export function renderQualityGates(blockedPaths: string[]): string {
  return [
    "# Quality Gates",
    "",
    "- Keep the diff focused on the active goal.",
    "- Do not edit blocked paths.",
    "- Add or update tests when behavior changes.",
    "- Run the narrowest meaningful validation before review.",
    "",
    "## Blocked Paths",
    "",
    ...blockedPaths.map((path) => `- ${path}`),
    ""
  ].join("\n");
}

export function renderAgentInstructions(session: SessionRecord): string {
  return [
    "# Agent Instructions",
    "",
    `Implement the goal for session ${session.id}: ${session.goal}`,
    "",
    "Read the current Visp Hyper files before editing code. Inspect only relevant files first, keep the change scoped, validate it, then run `visp-hyper review` and `visp-hyper remember`.",
    ""
  ].join("\n");
}

function fenced(content: string): string {
  return ["```", content.trimEnd(), "```"].join("\n");
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) {
    return [];
  }
  return ["## Warnings", "", ...warnings.map((warning) => `- ${warning}`), ""];
}
