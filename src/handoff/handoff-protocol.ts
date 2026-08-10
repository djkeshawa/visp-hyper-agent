import type { HandoffProtocol, HandoffResource, IntegrationSeam, SessionRecord, ToolProfile } from "../core/types.js";

export const requiredResourceReads: readonly HandoffResource[] = [
  {
    path: ".visp/hyper/current/session.md",
    uri: "visp-hyper://current/session",
    title: "Current Session",
    mimeType: "text/markdown",
    source: "file"
  },
  {
    path: ".visp/hyper/current/context-pack.md",
    uri: "visp-hyper://current/context-pack",
    title: "Current Context Pack",
    mimeType: "text/markdown",
    source: "file"
  },
  {
    path: ".visp/hyper/current/context-manifest.json",
    uri: "visp-hyper://current/context-manifest",
    title: "Current Context Manifest",
    mimeType: "application/json",
    source: "file"
  },
  {
    uri: "visp-hyper://current/context-freshness",
    title: "Current Context Freshness",
    mimeType: "application/json",
    source: "computed"
  },
  {
    uri: "visp-hyper://current/kit-read-contract",
    title: "Current Kit Read Contract",
    mimeType: "application/json",
    source: "computed"
  },
  // P21-HYPER-01. The scout's raw file is deliberately NOT a required read: it
  // is the scout's own output, and reading it directly would let unreceipted
  // rows reach the implementer. The computed resource is the collected state —
  // receipted rows only, transcript discarded.
  {
    uri: "visp-hyper://current/scout-findings",
    title: "Current Scout Findings",
    mimeType: "application/json",
    source: "computed"
  },
  {
    path: ".visp/hyper/current/memory-pack.md",
    uri: "visp-hyper://current/memory-pack",
    title: "Current Memory Pack",
    mimeType: "text/markdown",
    source: "file"
  },
  {
    path: ".visp/hyper/current/quality-gates.md",
    uri: "visp-hyper://current/quality-gates",
    title: "Current Quality Gates",
    mimeType: "text/markdown",
    source: "file"
  },
  {
    path: ".visp/hyper/current/agent-instructions.md",
    uri: "visp-hyper://current/agent-instructions",
    title: "Current Agent Instructions",
    mimeType: "text/markdown",
    source: "file"
  }
] as const;

export const requiredReads = requiredResourceReads.flatMap((resource) => resource.path ? [resource.path] : []);

const workflow = [
  "Read the required files and MCP resources when available.",
  "Inspect only the relevant files listed in the context pack.",
  "Create a concise implementation plan.",
  "Implement the smallest safe change — ONE task at a time: finish and `visp save --task <id>` the current task before touching any other task's files.",
  "Add or update tests where appropriate.",
  "If running the app or its tests creates runtime files (data files, caches), gitignore them before saving — leftover artifacts read as out-of-scope changes.",
  "Run validation commands.",
  "Use `visp save` or `visp check` only as local evidence; Kit alone authorizes strict progression.",
  "Record session learnings with `visp learn`; it does not complete a Kit task."
];

const hardRules = [
  "Do not modify unrelated files.",
  "Do not add dependencies without justification.",
  "Do not touch blocked paths.",
  "Do not skip validation.",
  "Do not change public APIs unless the Visp-Kit spec requires it.",
  "Keep the diff focused."
];

// Each profile gives a weak model three concrete things: the action verb/tool
// for that surface, one exact example command, and a one-line expected-output
// cue so the model can self-verify it did the right thing. Modeled on
// visp-kit's gateReadingSection Allowed/Blocked example pattern.
const profileInstructions: Record<ToolProfile, { label: string; instructions: string[] }> = {
  generic: {
    label: "Generic coding agent",
    instructions: [
      "Open and read each file under required_reads with your file-read tool before writing any code.",
      "Collect local validation evidence by running exactly: visp save --task T001 (substitute the real task id).",
      "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
    ]
  },
  codex: {
    label: "Codex",
    instructions: [
      "Use your repository read tool on every required_reads path, then make focused edits only inside the allowed file scope.",
      "Collect local validation evidence by running exactly: visp save --task T001 (substitute the real task id).",
      "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
    ]
  },
  "claude-code": {
    label: "Claude Code",
    instructions: [
      "Read every required_reads path with the Read tool first, then use Edit for narrow changes inside the allowed file scope.",
      "Collect local validation evidence by running exactly: visp save --task T001 (substitute the real task id).",
      "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
    ]
  },
  copilot: {
    label: "GitHub Copilot",
    instructions: [
      "Read the generated context files under required_reads before editing and stay inside the allowed file scope.",
      "Collect local validation evidence by running exactly: visp save --task T001 (substitute the real task id).",
      "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
    ]
  },
  opencode: {
    label: "OpenCode",
    instructions: [
      "Read each required_reads path with your file tool, keep edits inside the allowed file scope, and preserve the handoff block structure.",
      "Collect local validation evidence by running exactly: visp save --task T001 (substitute the real task id).",
      "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
    ]
  }
};

const integrationSeams: IntegrationSeam[] = [
  {
    id: "llm-memory-provider",
    capability: "llm-memory local-first provider",
    status: "typed-seam",
    notes: "Future adapter can implement MemoryProvider without changing CLI command contracts."
  },
  {
    id: "semantic-retrieval",
    capability: "ArcadeDB-backed semantic recall and reranking",
    status: "typed-seam",
    notes: "SemanticMemoryProvider is a no-dependency TypeScript seam only."
  },
  {
    id: "validation-runner",
    capability: "Validation command detection and execution",
    status: "typed-seam",
    notes: "ValidationCommandRunner can be implemented later by project-specific adapters."
  },
  {
    id: "branch-sessions",
    capability: "Branch-aware session tracking",
    status: "typed-seam",
    notes: "BranchSessionLocator defines lookup shape without changing persisted state yet."
  },
  {
    id: "mcp-bridge",
    capability: "MCP server mode",
    status: "typed-seam",
    notes: "McpBridge defines tool listing shape without adding an MCP runtime dependency."
  }
];

export function buildHandoffProtocol(session: SessionRecord): HandoffProtocol {
  const profile = profileInstructions[session.tool];
  return {
    version: "0.1",
    sessionId: session.id,
    goal: session.goal,
    phase: session.phase,
    toolProfile: session.tool,
    toolProfileLabel: profile.label,
    profileInstructions: profile.instructions,
    requiredReads: [...requiredReads],
    requiredResources: requiredResourceReads.map((resource) => ({ ...resource })),
    workflow,
    hardRules,
    integrationSeams,
    nextInstruction: "Read the required files now, then continue with the implementation workflow.",
    completionInstruction: "After validation, treat Hyper results as local evidence; in Kit-backed work follow the exact current ready Kit action. Record session learnings with `visp learn`; it does not complete a Kit task."
  };
}

export interface RenderHandoffOptions {
  skills?: Array<{ name: string; whenToUse: string }>;
}

const skillProtocol = [
  "skill_protocol:",
  "  To propose a reusable skill, write a markdown file to .visp/hyper/skill-proposals/incoming/<kebab-name>.md",
  "  with frontmatter (name, description, when_to_use, evidence) and the skill steps as the body."
];

export function renderHandoff(session: SessionRecord, options?: RenderHandoffOptions): string {
  const handoff = buildHandoffProtocol(session);
  const lines = [
    "BEGIN_VISP_AGENT_HANDOFF",
    `version: ${handoff.version}`,
    `session_id: ${handoff.sessionId}`,
    `goal: ${handoff.goal}`,
    `phase: ${handoff.phase}`,
    `tool_profile: ${handoff.toolProfile}`,
    `tool_profile_label: ${handoff.toolProfileLabel}`,
    "",
    "profile_instructions:",
    ...handoff.profileInstructions.map((instruction) => `  - ${instruction}`),
    "",
    "required_reads:",
    ...handoff.requiredReads.map((path) => `  - ${path}`),
    "",
    "mcp_resources:",
    ...handoff.requiredResources.map((resource) => `  - ${resource.uri} (${resource.path ?? "computed"})`),
    "",
    "workflow:",
    ...handoff.workflow.map((step, index) => `  ${index + 1}. ${step}`),
    "",
    "hard_rules:",
    ...handoff.hardRules.map((rule) => `  - ${rule}`),
    "",
    "integration_seams:",
    ...handoff.integrationSeams.map((seam) => `  - ${seam.id}: ${seam.capability} (${seam.status})`),
    "",
    "next_instruction:",
    `  ${handoff.nextInstruction}`,
    "",
    "completion_instruction:",
    `  ${handoff.completionInstruction}`
  ];

  // Only run/start pass `options`; skill details stay opt-in so plain handoff
  // rendering remains stable apart from intentional protocol fields.
  if (options) {
    const skills = options.skills ?? [];
    if (skills.length > 0) {
      lines.push("", "project_skills:");
      for (const skill of skills) {
        lines.push(`  - hyper-${skill.name}: ${skill.whenToUse}`);
      }
    }
    lines.push("", ...skillProtocol);
  }

  lines.push("END_VISP_AGENT_HANDOFF");
  return lines.join("\n");
}
