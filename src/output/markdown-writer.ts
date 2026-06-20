import type { ContextFile, ContextPackOptions, KitArtifacts, MemoryPack, SessionRecord } from "../core/types.js";
import type { FailurePattern } from "../memory/failure-patterns.js";

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

export function renderContextPack(files: ContextFile[], kit: KitArtifacts, options: ContextPackOptions = {}): string {
  const source = options.source ? [`- Source: ${options.source}`, ""] : [];
  const validationCommands =
    options.validationCommands && options.validationCommands.length > 0
      ? ["## Validation Commands", "", ...options.validationCommands.map((command) => `- ${command}`), ""]
      : [];
  return [
    "# Context Pack",
    "",
    ...source,
    ...validationCommands,
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

export type RecalledMemory = {
  summary: string;
  content: string;
  category: string;
  score: number | null;
};

export type RenderMemoryPackOptions = {
  recalled?: RecalledMemory[];
  recalledWarnings?: string[];
  failurePatterns?: FailurePattern[];
};

const recalledContentBudget = 12_000;

export function renderMemoryPack(memory: MemoryPack, options: RenderMemoryPackOptions = {}): string {
  const recalled = renderRecalledSection(options.recalled);
  const failures = renderFailurePatternSection(options.failurePatterns);
  const warnings = renderWarnings([...memory.warnings, ...(options.recalledWarnings ?? [])]);
  if (memory.files.length === 0) {
    return ["# Memory Pack", "", ...warnings, "No local Visp memory files found yet.", "", ...failures, ...recalled].join("\n");
  }
  return [
    "# Memory Pack",
    "",
    ...warnings,
    ...memory.files.flatMap((file) => [`## ${file.path}`, "", `Summary: ${file.summary}`, "", fenced(file.content), ""]),
    ...failures,
    ...recalled
  ].join("\n");
}

function renderFailurePatternSection(patterns: FailurePattern[] | undefined): string[] {
  if (!patterns || patterns.length === 0) {
    return [];
  }
  const lines: string[] = ["## Known Failure Patterns", ""];
  for (const pattern of patterns) {
    lines.push(
      `### ${pattern.taskId} (${pattern.taskClass})`,
      "",
      `- Source: ${pattern.source}`,
      `- Last seen: ${pattern.lastSeenAt}`,
      `- Occurrences: ${pattern.occurrences}`,
      `- Related files: ${pattern.relatedFiles.length > 0 ? pattern.relatedFiles.join(", ") : "none"}`,
      "- Findings:",
      ...pattern.findings.slice(0, 5).map((finding) => `  - ${finding}`),
      ""
    );
  }
  return lines;
}

function renderRecalledSection(recalled: RecalledMemory[] | undefined): string[] {
  if (!recalled || recalled.length === 0) {
    return [];
  }
  const lines: string[] = ["## Recalled Memories (llm-memory)", ""];
  let used = 0;
  let omitted = 0;
  for (const entry of recalled) {
    if (omitted > 0 || used + entry.content.length > recalledContentBudget) {
      omitted += 1;
      continue;
    }
    used += entry.content.length;
    lines.push(
      `### ${entry.summary}`,
      "",
      `- Source: llm-memory (${entry.category || "uncategorized"}, score ${formatScore(entry.score)})`,
      "",
      fenced(entry.content),
      ""
    );
  }
  if (omitted > 0) {
    lines.push(`- [${omitted} more memories omitted by size cap]`, "");
  }
  return lines;
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : score.toFixed(2);
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
