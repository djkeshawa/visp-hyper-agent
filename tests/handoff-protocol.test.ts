import { describe, expect, it } from "vitest";
import { buildHandoffProtocol, renderHandoff } from "../src/handoff/handoff-protocol.js";
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
    expect(handoff).toContain(".visp/hyper/current/context-manifest.json");
    expect(handoff).toContain("mcp_resources:");
    expect(handoff).toContain("visp-hyper://current/context-manifest");
    expect(handoff).toContain("visp-hyper://current/context-freshness (computed)");
    expect(handoff).toContain("visp-hyper://current/kit-read-contract (computed)");
    expect(handoff).toContain("completion_instruction:");
    expect(handoff).toContain("tool_profile_label: Codex");
    expect(handoff).toContain("profile_instructions:");
    expect(handoff).toContain("integration_seams:");
    expect(handoff).toContain("Do not change public APIs unless the Visp-Kit spec requires it.");
    expect(handoff).toContain("END_VISP_AGENT_HANDOFF");
  });

  it("builds the same core fields rendered to stdout", () => {
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

    const protocol = buildHandoffProtocol(session);
    const handoff = renderHandoff(session);

    expect(protocol).toMatchObject({
      version: "0.1",
      sessionId: "vh_test",
      goal: "implement offline note sync",
      phase: "implementation",
      toolProfile: "codex"
    });
    expect(handoff).toContain(`version: ${protocol.version}`);
    expect(handoff).toContain(`session_id: ${protocol.sessionId}`);
    expect(handoff).toContain(`tool_profile: ${protocol.toolProfile}`);
    expect(protocol.requiredReads).toContain(".visp/hyper/current/agent-instructions.md");
    expect(protocol.requiredReads).not.toContain(".visp/hyper/current/context-freshness.json");
    expect(protocol.requiredReads).not.toContain(".visp/hyper/current/kit-read-contract.json");
    expect(protocol.requiredResources).toContainEqual(
      expect.objectContaining({
        path: ".visp/hyper/current/context-manifest.json",
        uri: "visp-hyper://current/context-manifest",
        source: "file"
      })
    );
    expect(protocol.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/context-freshness",
        source: "computed"
      })
    );
    expect(protocol.requiredResources).toContainEqual(
      expect.objectContaining({
        uri: "visp-hyper://current/kit-read-contract",
        source: "computed"
      })
    );
    // 9 steps since the runtime-artifact hygiene line: round-5 evaluation
    // failed every save on the app's own data file created by its tests.
    expect(protocol.workflow).toHaveLength(9);
    expect(protocol.hardRules).toHaveLength(6);
    expect(protocol.integrationSeams.map((seam) => seam.id)).toEqual(
      expect.arrayContaining(["llm-memory-provider", "semantic-retrieval", "validation-runner", "branch-sessions", "mcp-bridge"])
    );
  });
});
