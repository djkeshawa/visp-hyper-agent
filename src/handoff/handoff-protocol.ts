import type { HandoffProtocol, SessionRecord } from "../core/types.js";

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

export function buildHandoffProtocol(session: SessionRecord): HandoffProtocol {
  return {
    version: "0.1",
    sessionId: session.id,
    goal: session.goal,
    phase: session.phase,
    toolProfile: session.tool,
    requiredReads: [...requiredReads],
    workflow,
    hardRules,
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
    "next_instruction:",
    `  ${handoff.nextInstruction}`,
    "",
    "completion_instruction:",
    `  ${handoff.completionInstruction}`,
    "END_VISP_AGENT_HANDOFF"
  ].join("\n");
}
