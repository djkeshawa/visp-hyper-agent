import type { HandoffProtocol, HandoffResource, IntegrationSeam, SessionRecord, ToolProfile } from "../core/types.js";

export const requiredResourceReads: readonly HandoffResource[] = [
  {
    path: ".visp/hyper/current/session.md",
    uri: "visp-hyper://current/session",
    title: "Current Session",
    mimeType: "text/markdown"
  },
  {
    path: ".visp/hyper/current/context-pack.md",
    uri: "visp-hyper://current/context-pack",
    title: "Current Context Pack",
    mimeType: "text/markdown"
  },
  {
    path: ".visp/hyper/current/context-manifest.json",
    uri: "visp-hyper://current/context-manifest",
    title: "Current Context Manifest",
    mimeType: "application/json"
  },
  {
    path: ".visp/hyper/current/memory-pack.md",
    uri: "visp-hyper://current/memory-pack",
    title: "Current Memory Pack",
    mimeType: "text/markdown"
  },
  {
    path: ".visp/hyper/current/quality-gates.md",
    uri: "visp-hyper://current/quality-gates",
    title: "Current Quality Gates",
    mimeType: "text/markdown"
  },
  {
    path: ".visp/hyper/current/agent-instructions.md",
    uri: "visp-hyper://current/agent-instructions",
    title: "Current Agent Instructions",
    mimeType: "text/markdown"
  }
] as const;

export const requiredReads = requiredResourceReads.map((resource) => resource.path);

const workflow = [
  "Read the required files.",
  "Inspect only the relevant files listed in the context pack.",
  "Create a concise implementation plan.",
  "Implement the smallest safe change.",
  "Add or update tests where appropriate.",
  "Run validation commands.",
  "Run `visp-hyper review`.",
  "Run `visp-hyper remember`."
];

const hardRules = [
  "Do not modify unrelated files.",
  "Do not add dependencies without justification.",
  "Do not touch blocked paths.",
  "Do not skip validation.",
  "Do not change public APIs unless the Visp-Kit spec requires it.",
  "Keep the diff focused."
];

const profileInstructions: Record<ToolProfile, { label: string; instructions: string[] }> = {
  generic: {
    label: "Generic coding agent",
    instructions: ["Use the protocol literally and keep responses concise."]
  },
  codex: {
    label: "Codex",
    instructions: ["Use repository tools for inspection and edits, then report validation evidence."]
  },
  "claude-code": {
    label: "Claude Code",
    instructions: ["Read the required files first, then use focused file edits and explicit validation steps."]
  },
  copilot: {
    label: "GitHub Copilot",
    instructions: ["Keep changes narrow and use the generated context files as the source of task truth."]
  },
  opencode: {
    label: "OpenCode",
    instructions: ["Follow the required reads and preserve the shared protocol structure in handoffs."]
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
    completionInstruction: "After implementation and validation, run `visp-hyper review` and `visp-hyper remember`."
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
    ...handoff.requiredResources.map((resource) => `  - ${resource.uri} (${resource.path})`),
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
