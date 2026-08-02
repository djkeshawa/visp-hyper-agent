// P10-US-05 (D-106): the thirteen-verb surface, pinned. `visp <verb>` for a
// human, `visp_<verb>` for a model, one vocabulary. The dispatcher decides
// nothing — this file pins the surface, not behavior.

import { describe, expect, it } from "vitest";

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { THIRTEEN_VERBS } from "../src/cli/index.js";
import { createMcpBridge } from "../src/mcp/tool-bridge.js";

const D106_VERBS = [
  "setup",
  "doctor",
  "new",
  "plan",
  "next",
  "work",
  "check",
  "save",
  "handoff",
  "status",
  "recall",
  "learn",
  "cockpit"
];

describe("the thirteen verbs (D-106)", () => {
  it("the CLI exports exactly the frozen D-106 verb table", () => {
    expect([...THIRTEEN_VERBS]).toEqual(D106_VERBS);
    expect(Object.isFrozen(THIRTEEN_VERBS)).toBe(true);
  });

  it("the MCP mirror is exactly visp_<verb>, 1:1 and in order", async () => {
    const tools = await createMcpBridge().listTools();
    expect(tools.map((tool) => tool.name)).toEqual(D106_VERBS.map((verb) => `visp_${verb}`));
  });
});

describe("one installed command set (P10-US-06)", () => {
  const templatesDir = fileURLToPath(new URL("../templates/claude-code", import.meta.url));

  it("installs exactly thirteen command files, one per verb, Hyper-owned", async () => {
    const manifest = JSON.parse(
      await readFile(`${templatesDir}/capabilities.json`, "utf8")
    ) as { assets: Array<{ templatePath: string; destination: string }> };
    const commands = manifest.assets.filter((asset) =>
      asset.destination.startsWith(".claude/commands/")
    );

    expect(commands.map((asset) => asset.destination)).toEqual(
      D106_VERBS.map((verb) => `.claude/commands/visp-${verb}.md`)
    );
    // The template files actually exist — a manifest entry with no template
    // would fail at install time, in the user's project.
    const onDisk = await readdir(`${templatesDir}/commands`);
    expect([...onDisk].sort()).toEqual(
      D106_VERBS.map((verb) => `visp-${verb}.md`).sort()
    );
  });

  it("no installed command carries the retired hyper-* naming", async () => {
    const onDisk = await readdir(`${templatesDir}/commands`);
    expect(onDisk.filter((name) => name.startsWith("hyper-"))).toEqual([]);
  });

  it("each command file invokes its own verb and no other verb's authority", async () => {
    for (const verb of D106_VERBS) {
      const body = await readFile(`${templatesDir}/commands/visp-${verb}.md`, "utf8");
      expect(body).toContain(`visp ${verb}`);
    }
  });
});
