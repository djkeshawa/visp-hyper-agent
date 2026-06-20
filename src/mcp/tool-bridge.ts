import { runCli } from "../cli/index.js";
import type { McpBridge } from "../core/types.js";
import { packageVersion } from "../core/package-version.js";
import type { McpContext, McpToolDef } from "./mcp-server.js";

/** Server version advertised over `initialize`; matches package.json. */
const SERVER_VERSION = packageVersion();

type ToolArgs = Record<string, unknown>;

type ToolSpec = {
  name: string;
  description: string;
  inputSchema: object;
  /** Validate arguments; return an error detail string, or null when valid. */
  validate: (args: ToolArgs) => string | null;
  /** Build the subcommand argv (without the leading `--project` block). */
  toArgv: (args: ToolArgs) => string[];
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Require a present string field; returns an error detail or null. */
function requireString(args: ToolArgs, key: string): string | null {
  if (!(key in args) || !isString(args[key]) || (args[key] as string).length === 0) {
    return `"${key}" must be a non-empty string`;
  }
  return null;
}

/** Validate an optional field with a type guard; returns an error detail or null. */
function optional(args: ToolArgs, key: string, guard: (v: unknown) => boolean, label: string): string | null {
  if (key in args && args[key] !== undefined && !guard(args[key])) {
    return `"${key}" must be ${label}`;
  }
  return null;
}

function firstError(...checks: Array<string | null>): string | null {
  return checks.find((check) => check !== null) ?? null;
}

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "hyper_quick",
    description: "Start a zero-config evidence-gated task; follow the printed action block.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        tool: { type: "string" }
      },
      required: ["goal"]
    },
    validate: (args) =>
      firstError(
        requireString(args, "goal"),
        optional(args, "files", isStringArray, "an array of strings"),
        optional(args, "tool", isString, "a string")
      ),
    toArgv: (args) => {
      const files = (args.files as string[] | undefined) ?? [];
      const fileArgs = files.length > 0 ? ["--files", ...files] : [];
      const toolArgs = isString(args.tool) ? ["--tool", args.tool] : [];
      return ["quick", args.goal as string, ...fileArgs, ...toolArgs];
    }
  },
  {
    name: "hyper_run",
    description: "Run the pipeline-aware gated session; follow the printed handoff and action block.",
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
      return ["run", args.goal as string, ...toolArgs];
    }
  },
  {
    name: "hyper_next",
    description: "Print the next recommended action for the active session.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["next"]
  },
  {
    name: "hyper_status",
    description: "Show the active Visp Hyper session status and generated artifact state.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["status"]
  },
  {
    name: "hyper_doctor",
    description: "Run the read-only Hyper + Kit integration health check.",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "boolean" }
      }
    },
    validate: (args) => optional(args, "json", (v) => typeof v === "boolean", "a boolean"),
    toArgv: (args) => (args.json === false ? ["doctor"] : ["doctor", "--json"])
  },
  {
    name: "hyper_checkpoint",
    description: "Run verify+review evidence; only proceed when status PASSED.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        tier: { type: "string" }
      },
      required: ["task"]
    },
    validate: (args) => firstError(requireString(args, "task"), optional(args, "tier", isString, "a string")),
    toArgv: (args) => {
      const tierArgs = isString(args.tier) ? ["--tier", args.tier] : [];
      return ["checkpoint", "--task", args.task as string, ...tierArgs];
    }
  },
  {
    name: "hyper_guard",
    description: "Mechanically enforce task scope against changed files.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["staged", "all"] },
        base: { type: "string" }
      }
    },
    validate: (args) => {
      if ("mode" in args && args.mode !== undefined && args.mode !== "staged" && args.mode !== "all") {
        return '"mode" must be "staged" or "all"';
      }
      return optional(args, "base", isString, "a string");
    },
    toArgv: (args) => {
      if (isString(args.base)) {
        return ["guard", "--base", args.base];
      }
      if (args.mode === "all") {
        return ["guard", "--all"];
      }
      return ["guard", "--staged"];
    }
  },
  {
    name: "hyper_review",
    description: "Write a deterministic local diff review report.",
    inputSchema: { type: "object", properties: {} },
    validate: () => null,
    toArgv: () => ["review"]
  },
  {
    name: "hyper_remember",
    description: "Write a local memory summary for the active session.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        decisions: { type: "array", items: { type: "string" } },
        followUps: { type: "array", items: { type: "string" } },
        usedSkills: { type: "array", items: { type: "string" } },
        inputTokens: { type: "number" },
        outputTokens: { type: "number" },
        model: { type: "string" }
      },
      required: ["summary"]
    },
    validate: (args) =>
      firstError(
        requireString(args, "summary"),
        optional(args, "decisions", isStringArray, "an array of strings"),
        optional(args, "followUps", isStringArray, "an array of strings"),
        optional(args, "usedSkills", isStringArray, "an array of strings"),
        optional(args, "inputTokens", isNumber, "a number"),
        optional(args, "outputTokens", isNumber, "a number"),
        optional(args, "model", isString, "a string")
      ),
    toArgv: (args) => {
      const argv = ["remember", "--summary", args.summary as string];
      const decisions = (args.decisions as string[] | undefined) ?? [];
      if (decisions.length > 0) {
        argv.push("--decision", ...decisions);
      }
      const followUps = (args.followUps as string[] | undefined) ?? [];
      if (followUps.length > 0) {
        argv.push("--follow-up", ...followUps);
      }
      const usedSkills = (args.usedSkills as string[] | undefined) ?? [];
      if (usedSkills.length > 0) {
        argv.push("--used-skill", ...usedSkills);
      }
      if (isNumber(args.inputTokens)) {
        argv.push("--input-tokens", String(args.inputTokens));
      }
      if (isNumber(args.outputTokens)) {
        argv.push("--output-tokens", String(args.outputTokens));
      }
      if (isString(args.model)) {
        argv.push("--model", args.model);
      }
      return argv;
    }
  },
  {
    name: "hyper_report",
    description: "Aggregate telemetry and routing state into a cost/accuracy evidence view.",
    inputSchema: {
      type: "object",
      properties: {
        json: { type: "boolean" }
      }
    },
    validate: (args) => optional(args, "json", (v) => typeof v === "boolean", "a boolean"),
    toArgv: (args) => (args.json === true ? ["report", "--json"] : ["report"])
  }
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

/**
 * Serializes tool executions so that the temporary console patching done by one
 * tool call never bleeds into a concurrent one. Each execution chains onto the
 * previous regardless of outcome.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run a CLI command in-process with all console output captured into a text
 * buffer. stdout/stderr of the host process are untouched (the MCP loop owns
 * stdout); console.* is redirected only for the duration of the command.
 */
async function executeTool(
  projectPath: string,
  name: string,
  args: ToolArgs
): Promise<{ text: string; isError: boolean }> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) {
    return { text: `invalid arguments: unknown tool ${name}`, isError: true };
  }

  const validationError = spec.validate(args);
  if (validationError) {
    return { text: `invalid arguments: ${validationError}`, isError: true };
  }

  const run = async (): Promise<{ text: string; isError: boolean }> => {
    const argv = ["node", "visp-hyper", "--project", projectPath, ...spec.toArgv(args)];
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const previousExitCode = process.exitCode;

    const capture = (...parts: unknown[]): void => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };

    let isError = false;
    process.exitCode = undefined;
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await runCli(argv);
    } catch (err) {
      lines.push(err instanceof Error ? err.message : String(err));
      isError = true;
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      const capturedExit = process.exitCode;
      isError = isError || (capturedExit !== undefined && capturedExit !== 0);
      process.exitCode = previousExitCode;
    }

    return { text: lines.join("\n"), isError };
  };

  const pending = queue.then(run, run);
  // Keep the chain alive but never let a rejection poison later executions.
  queue = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}

function toolDefs(): McpToolDef[] {
  return TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema
  }));
}

/**
 * Build the MCP context for a target project: the tool table, a project-bound
 * executor, and the server identity.
 */
export function createToolContext(projectPath: string): McpContext {
  return {
    tools: toolDefs(),
    execute: (name, args) => executeTool(projectPath, name, args),
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
