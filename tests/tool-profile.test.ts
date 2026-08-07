import { describe, expect, it } from "vitest";
import { startCommand } from "../src/cli/commands/start.js";
import { buildHandoffProtocol, renderHandoff } from "../src/handoff/handoff-protocol.js";
import type { SessionRecord, ToolProfile } from "../src/core/types.js";

function sessionFor(tool: ToolProfile): SessionRecord {
  return {
    id: `vh_${tool}`,
    goal: "implement sync",
    tool,
    projectPath: "/tmp/project",
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    phase: "implementation",
    relevantFiles: []
  };
}

describe("tool profiles", () => {
  it("changes profile metadata and wording while preserving shared protocol structure", () => {
    const codex = buildHandoffProtocol(sessionFor("codex"));
    const claude = buildHandoffProtocol(sessionFor("claude-code"));

    expect(codex.toolProfileLabel).toBe("Codex");
    expect(claude.toolProfileLabel).toBe("Claude Code");
    expect(codex.profileInstructions).not.toEqual(claude.profileInstructions);
    expect(codex.requiredReads).toEqual(claude.requiredReads);
    expect(codex.workflow).toEqual(claude.workflow);
    expect(codex.hardRules).toEqual(claude.hardRules);
    expect(renderHandoff(sessionFor("opencode"))).toContain("tool_profile_label: OpenCode");
  });

  it("keeps checkpoint progression and remembrance wording authority-neutral", () => {
    const profiles: ToolProfile[] = ["generic", "codex", "claude-code", "copilot", "opencode"];

    for (const profile of profiles) {
      const protocol = buildHandoffProtocol(sessionFor(profile));
      expect(protocol.profileInstructions).toContain(
        "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
      );
      expect(protocol.profileInstructions.join("\n")).not.toMatch(/PASSED.*(continue|clears|advance)/iu);
      // The verb, not the legacy binary: the handoff is agent-facing text, and
      // naming `visp-hyper remember` taught every agent to abandon the
      // thirteen-verb surface at the exact moment it finished a task.
      expect(protocol.workflow).toContain(
        "Record session learnings with `visp learn`; it does not complete a Kit task."
      );
      expect(protocol.completionInstruction).toContain("does not complete a Kit task");
    }
  });

  it("rejects unknown tool values through the start command option parser", async () => {
    const command = startCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync(["node", "start", "goal", "--tool", "unknown"])).rejects.toThrow(/is invalid/);
  });

  it("exposes typed Phase 7 integration seams without runtime dependencies", () => {
    const protocol = buildHandoffProtocol(sessionFor("generic"));

    expect(protocol.integrationSeams).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "llm-memory-provider", status: "typed-seam" }),
        expect.objectContaining({ id: "semantic-retrieval", status: "typed-seam" }),
        expect.objectContaining({ id: "mcp-bridge", status: "typed-seam" })
      ])
    );
  });
});
