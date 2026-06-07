import type { SessionRecord } from "../core/types.js";

export function renderHandoff(session: SessionRecord): string {
  return [
    "BEGIN_VISP_AGENT_HANDOFF",
    "version: 0.1",
    `session_id: ${session.id}`,
    `goal: ${session.goal}`,
    `phase: ${session.phase}`,
    `tool_profile: ${session.tool}`,
    "required_reads:",
    "  - .visp/hyper/current/session.md",
    "  - .visp/hyper/current/context-pack.md",
    "  - .visp/hyper/current/memory-pack.md",
    "  - .visp/hyper/current/quality-gates.md",
    "  - .visp/hyper/current/agent-instructions.md",
    "workflow:",
    "  1. Read the required files.",
    "  2. Inspect only the relevant files listed in the context pack.",
    "  3. Create a concise implementation plan.",
    "  4. Implement the smallest safe change.",
    "  5. Add or update tests where appropriate.",
    "  6. Run validation commands.",
    "  7. Run `visp-hyper review`.",
    "  8. Run `visp-hyper remember`.",
    "hard_rules:",
    "  - Do not modify unrelated files.",
    "  - Do not add dependencies without justification.",
    "  - Do not touch blocked paths.",
    "  - Do not skip validation.",
    "next_instruction: Read the required files now, then continue with the implementation workflow.",
    "END_VISP_AGENT_HANDOFF"
  ].join("\n");
}

