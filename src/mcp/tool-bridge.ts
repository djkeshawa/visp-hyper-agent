import { createHash } from "node:crypto";
import { runCli } from "../cli/index.js";
import type { McpBridge } from "../core/types.js";
import { packageVersion } from "../core/package-version.js";
import { readTextIfExists, vispPath } from "../core/fs-utils.js";
import { checkContextFreshness } from "../context/context-freshness.js";
import { detectVisp, KitCommandBridge } from "../kit/kit-command-bridge.js";
import { readScoutFindings } from "../scout/scout-findings.js";
import {
  toHyperActionEnvelope,
  type HyperActionEnvelopeV1
} from "../kit/workflow-action-renderer.js";
import type {
  McpContext,
  McpPromptDef,
  McpResourceContent,
  McpResourceDef,
  McpToolDef
} from "./mcp-server.js";

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

const HYPER_TOOL_OUTPUT_SCHEMA = {
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

// P10-US-05 (D-106): exactly thirteen normally registered tools, mirroring the
// thirteen verbs 1:1 — `visp_<verb>` for a model, `visp <verb>` for a human,
// one vocabulary. Each tool maps to the fixed local dispatcher verb; the
// dispatcher decides nothing. Memory's own larger MCP server remains an
// explicit standalone escape hatch and is never co-registered here.
const TOOL_SPECS: ToolSpec[] = [
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
    description: "Record a checkpoint of the current work; PASSED does not authorize strict Kit progression.",
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
      return ["save", "--task", args.task as string, ...tierArgs];
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

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]));

type ResourceSpec = McpResourceDef & {
  path: string[];
  priority?: number;
};

type CanonicalActionResourceV1 =
  | {
      resourceVersion: "1.0";
      availability: "available";
      envelope: HyperActionEnvelopeV1;
    }
  | {
      resourceVersion: "1.0";
      availability: "unavailable";
      authority: "none";
      reasonCode: "no_kit_signals";
      reason: string;
    }
  | {
      resourceVersion: "1.0";
      availability: "inconclusive";
      authority: "kit";
      reasonCode: string;
      reason: string;
    };

const RESOURCE_SPECS: ResourceSpec[] = [
  {
    uri: "visp-hyper://current/session",
    name: "session.md",
    title: "Current Session",
    description: "Human-readable current session summary.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "session.md"],
    priority: 0.8
  },
  {
    uri: "visp-hyper://current/context-pack",
    name: "context-pack.md",
    title: "Current Context Pack",
    description: "Task-scoped files, reasons, validation commands, and Kit warnings.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "context-pack.md"],
    priority: 1
  },
  {
    uri: "visp-hyper://current/context-manifest",
    name: "context-manifest.json",
    title: "Current Context Manifest",
    description: "Machine-readable required reads, MCP resources, files, validation, and failure-pattern context.",
    mimeType: "application/json",
    path: ["hyper", "current", "context-manifest.json"],
    priority: 1
  },
  {
    uri: "visp-hyper://current/memory-pack",
    name: "memory-pack.md",
    title: "Current Memory Pack",
    description: "Recalled local or llm-memory entries for the active session.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "memory-pack.md"],
    priority: 0.7
  },
  {
    uri: "visp-hyper://current/quality-gates",
    name: "quality-gates.md",
    title: "Current Quality Gates",
    description: "Validation, review, and scope gate guidance for the active session.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "quality-gates.md"],
    priority: 0.9
  },
  {
    uri: "visp-hyper://current/agent-instructions",
    name: "agent-instructions.md",
    title: "Current Agent Instructions",
    description: "Tool-profile-specific instructions generated by Visp Hyper.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "agent-instructions.md"]
  },
  {
    uri: "visp-hyper://current/handoff-json",
    name: "handoff.json",
    title: "Current Handoff JSON",
    description: "Structured handoff metadata for the active session.",
    mimeType: "application/json",
    path: ["hyper", "current", "handoff.json"],
    priority: 0.9
  },
  {
    uri: "visp-hyper://current/checkpoints",
    name: "checkpoints.md",
    title: "Current Checkpoints",
    description: "Checkpoint evidence and verify/review history for the active session.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "checkpoints.md"],
    priority: 0.8
  },
  {
    uri: "visp-hyper://current/checkpoint-snapshot",
    name: "checkpoint-snapshot.json",
    title: "Current Checkpoint Snapshot",
    description: "Machine-readable hashed file snapshot captured at the latest checkpoint.",
    mimeType: "application/json",
    path: ["hyper", "current", "checkpoint-snapshot.json"],
    priority: 0.8
  },
  {
    uri: "visp-hyper://current/review-report",
    name: "review-report.md",
    title: "Current Review Report",
    description: "Latest deterministic local diff review generated by Visp Hyper.",
    mimeType: "text/markdown",
    path: ["hyper", "current", "review-report.md"]
  },
  {
    uri: "visp-hyper://prompts/handoff",
    name: "visp-hyper-handoff.prompt.md",
    title: "Rendered Handoff Prompt",
    description: "The rendered handoff prompt mirrored for tools that prefer prompt files.",
    mimeType: "text/markdown",
    path: ["prompts", "visp-hyper-handoff.prompt.md"]
  }
];

const SURFACE_MANIFEST_RESOURCE: McpResourceDef = {
  uri: "visp-hyper://meta/surface-manifest",
  name: "surface-manifest.json",
  title: "MCP Surface Manifest",
  description: "Stable, hashed declaration of Visp Hyper MCP tools, resources, prompts, and safety posture.",
  mimeType: "application/json",
  annotations: {
    audience: ["user", "assistant"],
    priority: 1
  }
};

const CONTEXT_FRESHNESS_RESOURCE: McpResourceDef = {
  uri: "visp-hyper://current/context-freshness",
  name: "context-freshness.json",
  title: "Current Context Freshness",
  description: "Machine-readable freshness status for the active context pack and grounded Kit artifacts.",
  mimeType: "application/json",
  annotations: {
    audience: ["user", "assistant"],
    priority: 1
  }
};

const KIT_READ_CONTRACT_RESOURCE: McpResourceDef = {
  uri: "visp-hyper://current/kit-read-contract",
  name: "kit-read-contract.json",
  title: "Current Kit Read Contract",
  description: "Machine-readable Kit artifact read roles and freshness policy adopted into the active handoff.",
  mimeType: "application/json",
  annotations: {
    audience: ["user", "assistant"],
    priority: 1
  }
};

const CANONICAL_ACTION_RESOURCE: McpResourceDef = {
  uri: "visp-hyper://current/canonical-action",
  name: "canonical-action.json",
  title: "Current Canonical Action",
  mimeType: "application/json",
  annotations: {
    audience: ["user", "assistant"],
    priority: 1
  }
};

/**
 * P21-HYPER-01. Computed, not a file mirror: reading it runs the collector, so
 * the only scout state any consumer can obtain is the receipted, validated
 * subset. The raw `.visp/hyper/current/scout-findings.json` is never served.
 */
const SCOUT_FINDINGS_RESOURCE: McpResourceDef = {
  uri: "visp-hyper://current/scout-findings",
  name: "scout-findings.json",
  title: "Current Scout Findings",
  description: "Collected scout state: receipted entrypoints, path, affected tests, and unresolved questions.",
  mimeType: "application/json",
  annotations: {
    audience: ["user", "assistant"],
    priority: 0.9
  }
};

const PROMPTS: McpPromptDef[] = [
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
    inputSchema: spec.inputSchema,
    outputSchema: HYPER_TOOL_OUTPUT_SCHEMA
  }));
}

async function resourceDefs(projectPath: string): Promise<McpResourceDef[]> {
  const defs: McpResourceDef[] = [
    SURFACE_MANIFEST_RESOURCE,
    CONTEXT_FRESHNESS_RESOURCE,
    KIT_READ_CONTRACT_RESOURCE,
    CANONICAL_ACTION_RESOURCE,
    SCOUT_FINDINGS_RESOURCE
  ];
  for (const spec of RESOURCE_SPECS) {
    const content = await readTextIfExists(vispPath(projectPath, ...spec.path));
    if (content === undefined) {
      continue;
    }
    defs.push(resourceDefFromSpec(spec));
  }
  return defs;
}

async function readResource(projectPath: string, uri: string): Promise<McpResourceContent | null> {
  if (uri === SURFACE_MANIFEST_RESOURCE.uri) {
    return {
      uri,
      mimeType: SURFACE_MANIFEST_RESOURCE.mimeType,
      text: `${JSON.stringify(buildSurfaceManifest(), null, 2)}\n`
    };
  }

  if (uri === CONTEXT_FRESHNESS_RESOURCE.uri) {
    const freshness = await checkContextFreshness(projectPath);
    return {
      uri,
      mimeType: CONTEXT_FRESHNESS_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt: new Date().toISOString(),
          ...freshness
        },
        null,
        2
      )}\n`
    };
  }

  if (uri === KIT_READ_CONTRACT_RESOURCE.uri) {
    return readKitReadContractResource(projectPath, uri);
  }

  if (uri === SCOUT_FINDINGS_RESOURCE.uri) {
    const report = await readScoutFindings(projectPath);
    return {
      uri,
      mimeType: SCOUT_FINDINGS_RESOURCE.mimeType,
      text: `${JSON.stringify({ resourceVersion: "1.0", authority: "none", ...report }, null, 2)}\n`
    };
  }

  if (uri === CANONICAL_ACTION_RESOURCE.uri) {
    const body = await readCanonicalActionResource(projectPath);
    return {
      uri,
      mimeType: CANONICAL_ACTION_RESOURCE.mimeType,
      text: `${JSON.stringify(body, null, 2)}\n`
    };
  }

  const spec = RESOURCE_SPECS.find((candidate) => candidate.uri === uri);
  if (!spec) {
    return null;
  }
  const text = await readTextIfExists(vispPath(projectPath, ...spec.path));
  if (text === undefined) {
    return null;
  }
  return {
    uri: spec.uri,
    mimeType: spec.mimeType,
    text
  };
}

function resourceDefFromSpec(spec: ResourceSpec): McpResourceDef {
  return {
    uri: spec.uri,
    name: spec.name,
    title: spec.title,
    description: spec.description,
    mimeType: spec.mimeType,
    ...(spec.priority === undefined
      ? {}
      : {
          annotations: {
            audience: ["user", "assistant"] as Array<"user" | "assistant">,
            priority: spec.priority
          }
        })
  };
}

function buildSurfaceManifest(): object {
  const surface = {
    protocolVersion: "2025-06-18",
    serverInfo: { name: "visp-hyper", version: SERVER_VERSION },
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      sampling: false,
      elicitation: false,
      dynamicToolRegistration: false
    },
    tools: toolDefs().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchemaHash: hashStable(tool.inputSchema),
      outputSchemaHash: tool.outputSchema ? hashStable(tool.outputSchema) : undefined
    })),
    resources: [
      SURFACE_MANIFEST_RESOURCE,
      {
        ...CONTEXT_FRESHNESS_RESOURCE,
        computed: true
      },
      {
        ...KIT_READ_CONTRACT_RESOURCE,
        computed: true
      },
      {
        ...CANONICAL_ACTION_RESOURCE,
        computed: true
      },
      {
        ...SCOUT_FINDINGS_RESOURCE,
        computed: true
      },
      ...RESOURCE_SPECS.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        mimeType: resource.mimeType,
        description: resource.description,
        projectLocalPath: `.visp/${resource.path.join("/")}`
      }))
    ],
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments ?? []
    })),
    safetyPosture: {
      noLlmCalls: true,
      projectLocal: true,
      fixedToolTable: true,
      fixedResourceTable: true,
      fixedPromptTable: true,
      commandExecution: "MCP tools map to fixed local visp-hyper subcommands with typed argument validation.",
      structuredToolResults: "Each MCP tool advertises an outputSchema and returns structuredContent alongside the human-readable block.",
      networkPolicy: "No network calls from the MCP bridge; invoked commands may only contact a configured local llm-memory endpoint when memoryMode is enabled."
    }
  };
  return {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    surfaceHashAlgorithm: "sha256",
    surfaceHash: hashStable(surface),
    ...surface
  };
}

async function readCanonicalActionResource(
  projectPath: string
): Promise<CanonicalActionResourceV1> {
  const availability = await detectVisp(projectPath);
  if (availability.state === "absent") {
    return {
      resourceVersion: "1.0",
      availability: "unavailable",
      authority: "none",
      reasonCode: "no_kit_signals",
      reason: singleLineReason(availability.reason)
    };
  }
  if (availability.state === "configured-unhealthy") {
    return inconclusiveCanonicalAction(availability.reasonCode, availability.reason);
  }

  const bridge = new KitCommandBridge({ projectPath });
  const contractDiagnostic = await bridge.integrationContractDiagnostic();
  if (!contractDiagnostic.ok) {
    return inconclusiveCanonicalAction(
      contractDiagnostic.reasonCode,
      contractDiagnostic.reason
    );
  }

  const actionDiagnostic = await bridge.nextCanonicalActionDiagnostic(
    "auto",
    contractDiagnostic.value
  );
  if (!actionDiagnostic.ok) {
    return inconclusiveCanonicalAction(
      actionDiagnostic.reasonCode,
      actionDiagnostic.reason
    );
  }

  return {
    resourceVersion: "1.0",
    availability: "available",
    envelope: toHyperActionEnvelope(actionDiagnostic.value)
  };
}

function inconclusiveCanonicalAction(
  reasonCode: string,
  reason: string
): CanonicalActionResourceV1 {
  return {
    resourceVersion: "1.0",
    availability: "inconclusive",
    authority: "kit",
    reasonCode,
    reason: singleLineReason(reason)
  };
}

function singleLineReason(reason: string): string {
  return reason.replace(/[\r\n]+/gu, " ").trim();
}

async function readKitReadContractResource(projectPath: string, uri: string): Promise<McpResourceContent> {
  const generatedAt = new Date().toISOString();
  const manifestText = await readTextIfExists(vispPath(projectPath, "hyper", "current", "context-manifest.json"));
  if (!manifestText) {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "unavailable",
          reason: "context manifest is missing; run `visp work \"<goal>\"` to create the active handoff"
        },
        null,
        2
      )}\n`
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "error",
          reason: "context manifest is unreadable; regenerate with `visp work \"<goal>\"`"
        },
        null,
        2
      )}\n`
    };
  }

  const kitReadContract = manifest && typeof manifest === "object"
    ? (manifest as Record<string, unknown>).kitReadContract
    : undefined;
  if (!kitReadContract || typeof kitReadContract !== "object") {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "unavailable",
          reason: "active context manifest has no Kit read contract; rerun with a Visp Kit that advertises integration contract 1.3"
        },
        null,
        2
      )}\n`
    };
  }

  return {
    uri,
    mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
    text: `${JSON.stringify(
      {
        version: "0.1",
        generatedAt,
        ...kitReadContract,
        status: "available"
      },
      null,
      2
    )}\n`
  };
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function getPrompt(
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
