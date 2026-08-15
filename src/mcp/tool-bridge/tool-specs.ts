/**
 * What this server advertises: its version, its tool table, and the schemas
 * those tools promise.
 *
 * The table is the contract. Doctor hashes these schemas and holds a live
 * listing against them, so a change here is a change to a published surface.
 */

import { packageVersion } from "../../core/package-version.js";
import type { McpToolDef } from "../mcp-server.js";
import { firstError, isNonNegativeInteger, isString, optional, requireString } from "./arg-guards.js";
import type { ToolArgs } from "./arg-guards.js";


/** Server version advertised over `initialize`; matches package.json. */
export const SERVER_VERSION = packageVersion();

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: object;
  /** Validate arguments; return an error detail string, or null when valid. */
  validate: (args: ToolArgs) => string | null;
  /** Build the subcommand argv (without the leading `--project` block). */
  toArgv: (args: ToolArgs) => string[];
};

export const HYPER_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: { type: "string" },
    isError: { type: "boolean" },
    status: { type: "string" },
    frames: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          boundary: { type: "string", enum: ["begin", "end"] }
        },
        required: ["name", "boundary"]
      }
    },
    resourceUris: { type: "array", items: { type: "string" } },
    text: { type: "string" }
  },
  required: ["tool", "isError", "status", "frames", "resourceUris", "text"]
};

// P10-US-05 (D-106): exactly thirteen normally registered tools, mirroring the
// thirteen verbs 1:1 — `visp_<verb>` for a model, `visp <verb>` for a human,
// one vocabulary. Each tool maps to the fixed local dispatcher verb; the
// dispatcher decides nothing. Memory's own larger MCP server remains an
// explicit standalone escape hatch and is never co-registered here.
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "visp_setup",
    description: "Install and verify the matched Visp pair and host registration (machine scope).",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["setup"]
  },
  {
    name: "visp_doctor",
    description: "Check this machine and project: versions, pairing, generated assets, stale CI.",
    inputSchema: {
      type: "object",
      properties: { json: { type: "boolean" } }
    },
    validate: (args) => optional(args, "json", (v) => typeof v === "boolean", "a boolean"),
    toArgv: (args) => (args.json === false ? ["doctor"] : ["doctor", "--json"])
  },
  {
    name: "visp_new",
    description: "Start a piece of work: register the goal with Kit and prepare it as far as Kit allows.",
    inputSchema: {
      type: "object",
      properties: { goal: { type: "string" } },
      required: ["goal"]
    },
    validate: (args) => requireString(args, "goal"),
    toArgv: (args) => ["new", args.goal as string]
  },
  {
    name: "visp_plan",
    description: "Drive Kit's preparation for the active feature until implementation is allowed.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["plan"]
  },
  {
    name: "visp_next",
    description: "Ask Kit for the single next action. Kit decides; this only relays.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["next"]
  },
  {
    name: "visp_work",
    description: "Drive the coding tool through the prepared task (gated session).",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        tool: { type: "string" }
      },
      required: ["goal"]
    },
    validate: (args) => firstError(requireString(args, "goal"), optional(args, "tool", isString, "a string")),
    toArgv: (args) => {
      const toolArgs = isString(args.tool) ? ["--tool", args.tool] : [];
      return ["work", args.goal as string, ...toolArgs];
    }
  },
  {
    name: "visp_check",
    description: "Run the real checks and record evidence without changing any workflow state.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string" } }
    },
    validate: (args) => optional(args, "task", isString, "a string"),
    toArgv: (args) => (isString(args.task) ? ["check", "--task", args.task] : ["check"])
  },
  {
    name: "visp_save",
    description:
      "Record a checkpoint of the current work; PASSED does not authorize strict Kit progression. Pass input_tokens/output_tokens from your host's reported usage so the task closes with a real cost row instead of an unavailable one.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        tier: { type: "string" },
        input_tokens: { type: "integer", minimum: 0 },
        output_tokens: { type: "integer", minimum: 0 }
      },
      required: ["task"]
    },
    validate: (args) =>
      firstError(
        requireString(args, "task"),
        optional(args, "tier", isString, "a string"),
        optional(args, "input_tokens", isNonNegativeInteger, "a non-negative integer"),
        optional(args, "output_tokens", isNonNegativeInteger, "a non-negative integer")
      ),
    toArgv: (args) => {
      const tierArgs = isString(args.tier) ? ["--tier", args.tier] : [];
      // The host knows its own token counts; the coordinator never guesses
      // them. Forwarded only when actually supplied, so an absent count stays
      // a recorded absence rather than a fabricated zero.
      const inputArgs = isNonNegativeInteger(args.input_tokens)
        ? ["--input-tokens", String(args.input_tokens)]
        : [];
      const outputArgs = isNonNegativeInteger(args.output_tokens)
        ? ["--output-tokens", String(args.output_tokens)]
        : [];
      return ["save", "--task", args.task as string, ...tierArgs, ...inputArgs, ...outputArgs];
    }
  },
  {
    name: "visp_handoff",
    description: "Assemble the evidence for review: verify, review, assurance — as far as Kit allows.",
    // No `task` property: handoff follows Kit's own next answer, which already
    // carries the task Kit selected. Advertising one here promised an override
    // the CLI silently threw away.
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["handoff"]
  },
  {
    name: "visp_status",
    description: "Show the current session and workflow state.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["status"]
  },
  {
    name: "visp_recall",
    description: "Retrieve relevant memory for the active work (requires visp-memory; refuses visibly when absent).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"]
    },
    validate: (args) => requireString(args, "query"),
    toArgv: (args) => ["recall", args.query as string]
  },
  {
    name: "visp_learn",
    description: "Propose a durable memory through Memory's reviewed lifecycle; never a direct write.",
    inputSchema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"]
    },
    validate: (args) => requireString(args, "note"),
    toArgv: (args) => ["learn", args.note as string]
  },
  {
    name: "visp_cockpit",
    description: "Start the read-only local cockpit and print its address.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["cockpit"]
  }
];

export const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

export function toolDefs(): McpToolDef[] {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: HYPER_TOOL_OUTPUT_SCHEMA
  }));
}
