// P10-US-05 (D-106): the thirteen-verb surface, pinned. `visp <verb>` for a
// human, `visp_<verb>` for a model, one vocabulary. The dispatcher decides
// nothing — this file pins the surface, not behavior.

import { describe, expect, it } from "vitest";

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
