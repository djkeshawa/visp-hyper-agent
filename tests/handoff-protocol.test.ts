import { describe, expect, it } from "vitest";
import { renderHandoff } from "../src/handoff/handoff-protocol.js";
import type { SessionRecord } from "../src/core/types.js";

describe("renderHandoff", () => {
  it("renders required reads and workflow boundaries", () => {
    const session: SessionRecord = {
      id: "vh_test",
      goal: "implement offline note sync",
      tool: "codex",
      projectPath: "/tmp/project",
      createdAt: "2026-06-07T00:00:00.000Z",
      updatedAt: "2026-06-07T00:00:00.000Z",
      phase: "implementation",
      relevantFiles: ["src/index.ts"]
    };

    const handoff = renderHandoff(session);

    expect(handoff).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(handoff).toContain("session_id: vh_test");
    expect(handoff).toContain(".visp/hyper/current/context-pack.md");
    expect(handoff).toContain("END_VISP_AGENT_HANDOFF");
  });
});

