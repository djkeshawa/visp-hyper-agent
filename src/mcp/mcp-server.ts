import { read, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { deriveOutputStatus } from "./output-status.js";

/**
 * A single MCP tool advertised over `tools/list` and invocable via `tools/call`.
 * `inputSchema` is a JSON Schema object describing the tool's `arguments`.
 * `outputSchema`, when present, describes the returned `structuredContent`.
 */
export type McpToolDef = { name: string; description: string; inputSchema: object; outputSchema?: object };

/** Text plus optional structured output returned by a local MCP tool executor. */
export type McpToolExecution = {
  text: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
};

/** A read-only MCP resource exposed by Visp Hyper. */
export type McpResourceDef = {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: {
    audience?: Array<"user" | "assistant">;
    priority?: number;
    lastModified?: string;
  };
};

/** The textual body returned by `resources/read`. */
export type McpResourceContent = {
  uri: string;
  mimeType?: string;
  text: string;
};

/** A user-selectable MCP prompt template. */
export type McpPromptDef = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type McpPromptMessage = {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};

/**
 * Everything the protocol core needs to answer requests: the tool table, an
 * executor that runs a named tool and returns its captured text, and the
 * server identity echoed back during `initialize`.
 */
export type McpContext = {
  tools: McpToolDef[];
  execute: (name: string, args: Record<string, unknown>) => Promise<McpToolExecution>;
  validateToolArguments?: (name: string, args: Record<string, unknown>) => string | null;
  resources?: () => Promise<McpResourceDef[]>;
  readResource?: (uri: string) => Promise<McpResourceContent | null>;
  prompts?: McpPromptDef[];
  getPrompt?: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ description?: string; messages: McpPromptMessage[] } | null>;
  serverInfo: { name: string; version: string };
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
};

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const STDIO_READ_BUFFER_SIZE = 64 * 1024;
const STDIO_RETRY_MS = 1;

type JsonRpcId = number | string | null;

export class McpRequestError extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = "McpRequestError";
  }
}

class FileDescriptorInput extends Readable {
  private readonly buffer = Buffer.allocUnsafe(STDIO_READ_BUFFER_SIZE);
  private reading = false;

  constructor(private readonly fd: number) {
    super();
  }

  override _read(): void {
    if (this.reading || this.destroyed) {
      return;
    }
    this.reading = true;
    read(this.fd, this.buffer, 0, this.buffer.length, null, (error, bytesRead) => {
      this.reading = false;
      if (error) {
        if (error.code === "EAGAIN" || error.code === "EWOULDBLOCK") {
          setTimeout(() => this._read(), STDIO_RETRY_MS);
          return;
        }
        this.destroy(error);
        return;
      }
      if (bytesRead === 0) {
        this.push(null);
        return;
      }
      this.push(Buffer.from(this.buffer.subarray(0, bytesRead)));
    });
  }
}

function result(id: JsonRpcId, value: object): object {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeProtocolMessage(message: object): void {
  writeSync(process.stdout.fd, `${JSON.stringify(message)}\n`);
}

function capabilities(ctx: McpContext): Record<string, object> {
  return {
    tools: {},
    ...(ctx.resources && ctx.readResource ? { resources: {} } : {}),
    ...(ctx.prompts && ctx.getPrompt ? { prompts: {} } : {})
  };
}

function structuredContentFor(
  toolName: string,
  execution: McpToolExecution
): Record<string, unknown> {
  return {
    tool: toolName,
    isError: execution.isError,
    status: deriveOutputStatus(execution.text, execution.isError),
    frames: extractFrames(execution.text),
    resourceUris: extractResourceUris(execution.text),
    text: execution.text
  };
}

function extractFrames(text: string): Array<{ name: string; boundary: "begin" | "end" }> {
  const frames: Array<{ name: string; boundary: "begin" | "end" }> = [];
  const pattern = /\b(BEGIN|END)_([A-Z0-9_]+)\b|\b(VISP_HYPER_REPORT)\b/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[3]) {
      frames.push({ name: match[3], boundary: "begin" });
      continue;
    }
    const boundary = match[1] === "BEGIN" ? "begin" : "end";
    frames.push({ name: match[2] ?? "", boundary });
  }
  return frames;
}

function extractResourceUris(text: string): string[] {
  return [...new Set(text.match(/\bvisp-hyper:\/\/[^\s)]+/gu) ?? [])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function paramsRecord(value: unknown): Record<string, unknown> | null {
  if (value === undefined) {
    return {};
  }
  return isRecord(value) ? value : null;
}

/**
 * Pure JSON-RPC dispatch for the MCP surface. Returns the response object to
 * write back, or `null` when the message is a valid notification.
 */
export async function handleMessage(ctx: McpContext, message: unknown): Promise<object | null> {
  if (!isRecord(message)) {
    return error(null, -32600, "Invalid request");
  }

  const hasId = Object.hasOwn(message, "id");
  if (hasId && !isJsonRpcId(message.id)) {
    return error(null, -32600, "Invalid request");
  }
  const id: JsonRpcId = hasId ? (message.id as JsonRpcId) : null;

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return error(id, -32600, "Invalid request");
  }

  // A valid JSON-RPC notification has no id. MCP request methods are never
  // executed as notifications, which prevents unaddressable side effects.
  if (!hasId) {
    return null;
  }

  const method = message.method;
  try {
    switch (method) {
      case "initialize": {
        const params = paramsRecord(message.params);
        if (!params) {
          return error(id, -32602, "Initialize params must be an object");
        }
        const requestedVersion = params.protocolVersion;
        if (
          requestedVersion !== undefined &&
          (typeof requestedVersion !== "string" || requestedVersion.length === 0)
        ) {
          return error(id, -32602, "protocolVersion must be a non-empty string");
        }
        return result(id, {
          // This server implements one protocol version. Unsupported client
          // versions negotiate to that supported value instead of being echoed.
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: capabilities(ctx),
          serverInfo: ctx.serverInfo
        });
      }
      case "ping": {
        if (!paramsRecord(message.params)) {
          return error(id, -32602, "Ping params must be an object");
        }
        return result(id, {});
      }
      case "tools/list": {
        if (!paramsRecord(message.params)) {
          return error(id, -32602, "Tool list params must be an object");
        }
        return result(id, { tools: ctx.tools });
      }
      case "tools/call": {
        const params = paramsRecord(message.params);
        if (!params) {
          return error(id, -32602, "Tool call params must be an object");
        }
        const name = params.name;
        if (typeof name !== "string" || name.length === 0) {
          return error(id, -32602, "Tool name must be a non-empty string");
        }
        const rawArguments = Object.hasOwn(params, "arguments") ? params.arguments : {};
        if (!isRecord(rawArguments)) {
          return error(id, -32602, "Tool arguments must be an object");
        }
        const tool = ctx.tools.find((candidate) => candidate.name === name);
        if (!tool) {
          return error(id, -32602, `Unknown tool: ${name}`);
        }
        const validationError = ctx.validateToolArguments?.(name, rawArguments);
        if (validationError) {
          return error(id, -32602, `Invalid arguments for ${name}: ${validationError}`);
        }
        const execution = await ctx.execute(name, rawArguments);
        const response: Record<string, unknown> = {
          content: [{ type: "text", text: execution.text }],
          isError: execution.isError
        };
        const structuredContent =
          execution.structuredContent ?? (tool.outputSchema ? structuredContentFor(name, execution) : undefined);
        if (structuredContent) {
          response.structuredContent = structuredContent;
        }
        return result(id, response);
      }
      case "resources/list": {
        if (!ctx.resources || !ctx.readResource) {
          return error(id, -32601, "Method not found");
        }
        if (!paramsRecord(message.params)) {
          return error(id, -32602, "Resource list params must be an object");
        }
        return result(id, { resources: await ctx.resources() });
      }
      case "resources/read": {
        if (!ctx.resources || !ctx.readResource) {
          return error(id, -32601, "Method not found");
        }
        const params = paramsRecord(message.params);
        if (!params) {
          return error(id, -32602, "Resource read params must be an object");
        }
        const uri = params.uri;
        if (typeof uri !== "string" || uri.length === 0) {
          return error(id, -32602, "Resource uri must be a non-empty string");
        }
        const content = await ctx.readResource(uri);
        if (!content) {
          return error(id, -32602, `Unknown resource: ${uri}`);
        }
        return result(id, { contents: [content] });
      }
      case "prompts/list": {
        if (!ctx.prompts || !ctx.getPrompt) {
          return error(id, -32601, "Method not found");
        }
        if (!paramsRecord(message.params)) {
          return error(id, -32602, "Prompt list params must be an object");
        }
        return result(id, { prompts: ctx.prompts });
      }
      case "prompts/get": {
        if (!ctx.prompts || !ctx.getPrompt) {
          return error(id, -32601, "Method not found");
        }
        const params = paramsRecord(message.params);
        if (!params) {
          return error(id, -32602, "Prompt params must be an object");
        }
        const name = params.name;
        const rawArguments = Object.hasOwn(params, "arguments") ? params.arguments : {};
        if (typeof name !== "string" || name.length === 0) {
          return error(id, -32602, "Prompt name must be a non-empty string");
        }
        if (!isRecord(rawArguments)) {
          return error(id, -32602, "Prompt arguments must be an object");
        }
        if (!ctx.prompts.some((prompt) => prompt.name === name)) {
          return error(id, -32602, `Unknown prompt: ${name}`);
        }
        const prompt = await ctx.getPrompt(name, rawArguments);
        if (!prompt) {
          return error(id, -32602, `Invalid arguments for prompt: ${name}`);
        }
        return result(id, prompt);
      }
      default:
        return error(id, -32601, "Method not found");
    }
  } catch (caught) {
    if (caught instanceof McpRequestError) {
      return error(id, caught.code, caught.message);
    }
    return error(id, -32603, "Internal error");
  }
}

export type StdioServerOptions = {
  input?: Readable;
  writeMessage?: (message: object) => void;
  writeDiagnostic?: (message: string) => void;
};

/**
 * Run the newline-delimited JSON-RPC 2.0 stdio loop. stdout is the protocol
 * channel (one JSON object per line); all diagnostics go to stderr. Resolves
 * when stdin closes.
 */
export async function runStdioServer(
  ctx: McpContext,
  options: StdioServerOptions = {}
): Promise<void> {
  const input = options.input ?? new FileDescriptorInput(process.stdin.fd);
  const writeMessage = options.writeMessage ?? writeProtocolMessage;
  const writeDiagnostic = options.writeDiagnostic ?? ((message: string) => process.stderr.write(message));
  const rl = createInterface({ input });
  const inFlight = new Set<Promise<void>>();

  await new Promise<void>((resolve, reject) => {
    let shutdownStarted = false;
    let shutdownError: unknown;

    const drainInFlight = async (): Promise<void> => {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    };
    const shutdown = (failure?: unknown): void => {
      if (failure !== undefined && shutdownError === undefined) {
        shutdownError = failure;
      }
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      void drainInFlight().then(() => {
        if (shutdownError !== undefined) {
          reject(shutdownError);
        } else {
          resolve();
        }
      }, reject);
    };

    // readline re-emits input failures. Handle both emitters through one
    // idempotent drain so neither becomes an uncaught `error` event.
    input.on("error", shutdown);
    rl.on("error", shutdown);
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        writeDiagnostic("visp-hyper mcp: parse error on incoming line\n");
        writeMessage(error(null, -32700, "Parse error"));
        return;
      }

      const pending = handleMessage(ctx, parsed)
        .then((response) => {
          if (response !== null) {
            writeMessage(response);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          writeDiagnostic(`visp-hyper mcp: handler error: ${message}\n`);
        });
      inFlight.add(pending);
      void pending.then(
        () => inFlight.delete(pending),
        () => inFlight.delete(pending)
      );
    });

    rl.on("close", () => {
      shutdown();
    });
  });
}
