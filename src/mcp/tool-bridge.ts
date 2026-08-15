/**
 * The MCP surface Visp Hyper exposes to a model host.
 *
 * This file wires the pieces together and owns nothing else. The tool table,
 * the executor, the resources, and the prompts each live in `./tool-bridge/`,
 * because each is a published contract that is read and changed on its own.
 */

import type { McpBridge } from "../core/types.js";
import type { McpContext } from "./mcp-server.js";
import { SERVER_VERSION, TOOL_SPECS, toolDefs } from "./tool-bridge/tool-specs.js";
import { executeTool } from "./tool-bridge/execute.js";
import { PROMPTS, getPrompt } from "./tool-bridge/prompts.js";
import { resourceDefs } from "./tool-bridge/resource-specs.js";
import { readResource } from "./tool-bridge/resource-readers.js";

/**
 * Build the MCP context for a target project: the tool table, a project-bound
 * executor, and the server identity.
 */
export function createToolContext(projectPath: string): McpContext {
  return {
    tools: toolDefs(),
    execute: (name, args) => executeTool(projectPath, name, args),
    resources: () => resourceDefs(projectPath),
    readResource: (uri) => readResource(projectPath, uri),
    prompts: PROMPTS,
    getPrompt: (name, args) => getPrompt(projectPath, name, args),
    serverInfo: { name: "visp-hyper", version: SERVER_VERSION }
  };
}

/** The typed `McpBridge` seam: advertise the tool table's name + description. */
export function createMcpBridge(): McpBridge {
  return {
    async listTools() {
      return TOOL_SPECS.map((spec) => ({ name: spec.name, description: spec.description }));
    }
  };
}
