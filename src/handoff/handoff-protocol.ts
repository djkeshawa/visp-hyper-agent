import type { HandoffProtocol, IntegrationSeam, SessionRecord, ToolProfile } from "../core/types.js";

export const requiredReads = [
  ".visp/hyper/current/session.md",
  ".visp/hyper/current/context-pack.md",
  ".visp/hyper/current/memory-pack.md",
  ".visp/hyper/current/quality-gates.md",
  ".visp/hyper/current/agent-instructions.md"
] as const;

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
    workflow,
    hardRules,
    integrationSeams,
    nextInstruction: "Read the required files now, then continue with the implementation workflow.",
    completionInstruction: "After implementation and validation, run `visp-hyper review` and `visp-hyper remember`."
  };
}

export function renderHandoff(session: SessionRecord): string {
  const handoff = buildHandoffProtocol(session);
  return [
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
    `  ${handoff.completionInstruction}`,
    "END_VISP_AGENT_HANDOFF"
  ].join("\n");
}
