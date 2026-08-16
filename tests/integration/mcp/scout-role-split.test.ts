import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureDir } from "../../../src/core/fs-utils.js";
import { requiredReads, requiredResourceReads } from "../../../src/handoff/handoff-protocol.js";
import { installAssets, planInstall } from "../../../src/install/tool-asset-installer.js";
import { handleMessage } from "../../../src/mcp/mcp-server.js";
import { createToolContext } from "../../../src/mcp/tool-bridge.js";

const REAL_TEMPLATES = join(process.cwd(), "templates");

const SCOUT_FINDINGS_URI = "visp-hyper://current/scout-findings";

/** Tools that let an agent touch the working tree instead of the graph. */
const EDITING_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write"];

async function installedClaudeProject(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "vh-scout-split-"));
  await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });
  return project;
}

function frontmatterTools(body: string): string[] {
  const line = body.split("\n").find((candidate) => candidate.startsWith("tools:"));
  return (line ?? "")
    .replace(/^tools:/u, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

describe("the scout is navigation only (ADR 0014 Q4)", () => {
  it("grants no tool that can read, run or edit the working tree", async () => {
    const project = await installedClaudeProject();
    const scout = await readFile(join(project, ".claude/agents/scout.md"), "utf8");
    const tools = frontmatterTools(scout);

    expect(tools.length).toBeGreaterThan(0);
    for (const forbidden of EDITING_TOOLS) {
      expect(tools).not.toContain(forbidden);
    }
    // A scout that can edit will edit; every granted tool is one intel query.
    expect(tools.every((tool) => tool.startsWith("mcp__visp-intel__"))).toBe(true);
    expect(scout).not.toContain("{{");
  });

  it("declares the six actions and the twelve-action cap", async () => {
    const project = await installedClaudeProject();
    const scout = await readFile(join(project, ".claude/agents/scout.md"), "utf8");
    for (const action of ["`search`", "`callers`", "`callees`", "`path`", "`entity`", "`tests`"]) {
      expect(scout).toContain(action);
    }
    expect(scout).toContain("12 actions, hard");
    // The scout returns state, not a conversation, and does not write the
    // artifact itself — writing it would need a tool it must not have.
    expect(scout).toContain("ONE JSON object");
    expect(scout).toContain("discarded");
  });
});

describe("the mechanical duties moved off the scout", () => {
  it("installs a separate mechanic agent that keeps the editing tools", async () => {
    const plan = await planInstall("claude-code", await mkdtemp(join(tmpdir(), "vh-plan-")), {
      templatesDir: REAL_TEMPLATES
    });
    expect(plan.map((asset) => asset.destination)).toContain(".claude/agents/mechanic.md");

    const project = await installedClaudeProject();
    const mechanic = await readFile(join(project, ".claude/agents/mechanic.md"), "utf8");
    expect(frontmatterTools(mechanic)).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "Edit",
      "TodoWrite"
    ]);
    // The model token must resolve, or the installed agent is unusable.
    expect(mechanic).toContain("model: sonnet");
    expect(mechanic).not.toContain("{{");
  });

  it("routes the coordinator's cheap tier to the mechanic, not the scout", async () => {
    const project = await installedClaudeProject();
    const coordinator = await readFile(join(project, ".claude/agents/coordinator.md"), "utf8");
    expect(coordinator).toContain("`mechanic`");
    expect(coordinator).toContain("navigation only");
  });
});

describe("only collected state crosses the handoff boundary", () => {
  it("offers the collected resource without making the raw file a required read", () => {
    expect(requiredReads).not.toContain(".visp/hyper/current/scout-findings.json");
    expect(requiredResourceReads).toContainEqual(
      expect.objectContaining({ uri: SCOUT_FINDINGS_URI, source: "computed" })
    );
    expect(requiredResourceReads.find((resource) => resource.uri === SCOUT_FINDINGS_URI)?.path).toBeUndefined();
  });

  it("serves the collected subset over MCP, never the raw payload", async () => {
    const project = await mkdtemp(join(tmpdir(), "vh-scout-mcp-"));
    await ensureDir(join(project, ".visp", "hyper", "current"));
    await writeFile(
      join(project, ".visp", "hyper", "current", "scout-findings.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        taskId: "T001",
        snapshotId: "snap",
        repositoryInstanceId: "inst",
        status: "unresolved",
        entrypoints: [
          { entityId: "ent:a", filePath: "src/a.ts", line: 0, receiptId: "rcp:1" }
        ],
        path: [],
        affectedTests: [],
        unresolved: [{ question: "no edge resolves", attemptedActions: ["path"], unknownId: null }],
        receiptIds: ["rcp:1"],
        budget: { actions: 3, maxActions: 12 },
        transcript: "everything the scout thought about along the way"
      }),
      "utf8"
    );

    const ctx = createToolContext(project);
    const listed = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/list"
    })) as { result: { resources: Array<{ uri: string }> } };
    expect(listed.result.resources.map((resource) => resource.uri)).toContain(SCOUT_FINDINGS_URI);

    const read = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: SCOUT_FINDINGS_URI }
    })) as { result: { contents: Array<{ mimeType: string; text: string }> } };
    const body = read.result.contents[0]?.text ?? "";
    expect(read.result.contents[0]?.mimeType).toBe("application/json");
    expect(body).not.toContain("transcript");
    expect(body).not.toContain("everything the scout thought about");

    const parsed = JSON.parse(body) as { state: string; authority: string };
    expect(parsed.state).toBe("accepted");
    // Hyper sequences; nothing it serves authorizes anything.
    expect(parsed.authority).toBe("none");
  });
});
