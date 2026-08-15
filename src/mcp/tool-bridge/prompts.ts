/**
 * The fixed prompt table and the handler that fills one in.
 *
 * The table is fixed on purpose — a prompt is a published surface, so it is
 * declared here rather than assembled per request.
 */

import type { McpPromptDef } from "../mcp-server.js";
import { resourceDefs } from "./resource-specs.js";
import type { ToolArgs } from "./arg-guards.js";

export const PROMPTS: McpPromptDef[] = [
  {
    name: "hyper_resume",
    title: "Resume Visp Hyper Work",
    description: "Re-ground the coding agent on the active Visp Hyper session before continuing."
  },
  {
    name: "hyper_run_goal",
    title: "Run A Gated Goal",
    description: "Start or continue a Visp Hyper gated implementation flow for a user goal.",
    arguments: [
      {
        name: "goal",
        description: "The implementation goal to pass to Visp Hyper.",
        required: true
      }
    ]
  }
];

export async function getPrompt(
  projectPath: string,
  name: string,
  args: ToolArgs
): Promise<{ description?: string; messages: Array<{ role: "user"; content: { type: "text"; text: string } }> } | null> {
  if (name === "hyper_resume") {
    const resources = await resourceDefs(projectPath);
    const resourceList = resources.length > 0
      ? resources.map((resource) => `- ${resource.uri} (${resource.title ?? resource.name})`).join("\n")
      : "- No current Visp Hyper resources exist yet; call `visp_status` or start with `visp_work`.";
    return {
      description: "Resume the active Visp Hyper session.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Resume the current Visp Hyper workflow safely.",
              "",
              "First read the available MCP resources:",
              resourceList,
              "",
              "Then call `visp_next` to get the current bounded action before editing.",
              "Respect allowed and forbidden files from the context pack.",
              "Run the relevant validation commands and use `visp_save` or `visp_check` only as local evidence.",
              "A Hyper checkpoint is local evidence only; strict progression and remediation require the exact current ready Kit action."
            ].join("\n")
          }
        }
      ]
    };
  }

  if (name === "hyper_run_goal") {
    const goal = args.goal;
    if (typeof goal !== "string" || goal.trim().length === 0) {
      return null;
    }
    return {
      description: "Run a gated Visp Hyper goal.",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Use the MCP tool \`visp_work\` with goal: ${goal.trim()}`,
              "",
              "Follow only the printed Visp Hyper handoff and task action.",
              "Read the MCP resources produced by the run before inspecting source files.",
              "Do not edit files outside the bounded action block.",
              "For Kit-backed work, strict progression and remediation require the exact current ready Kit action."
            ].join("\n")
          }
        }
      ]
    };
  }

  return null;
}
