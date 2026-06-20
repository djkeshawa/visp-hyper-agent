import { createInterface } from "node:readline";

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
};

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

function result(id: number | string | null, value: object): object {
  return { jsonrpc: "2.0", id, result: value };
}

function error(id: number | string | null, code: number, message: string): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
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
    status: extractStatus(execution.text, execution.isError),
    frames: extractFrames(execution.text),
    resourceUris: extractResourceUris(execution.text),
    text: execution.text
  };
}

function extractStatus(text: string, isError: boolean): string {
  const status = text.match(/\bstatus:\s*([A-Z_]+)/iu)?.[1];
  if (status) {
    return status.toUpperCase();
  }
  return isError ? "ERROR" : "OK";
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

/**
 * Pure JSON-RPC dispatch for the tools-only MCP surface. Returns the response
 * object to write back, or `null` when the message is a notification (or an
 * unaddressable malformed request) that warrants no reply.
 */
export async function handleMessage(ctx: McpContext, msg: JsonRpcMessage): Promise<object | null> {
  const id = msg.id ?? null;
  const method = msg.method;

  // Notifications carry no id and expect no response.
  if (method && method.startsWith("notifications/")) {
    return null;
  }

  if (method === undefined) {
    // A request must name a method; without one it is invalid (only answerable
    // when it carries an id to address the error to).
    return id === null ? null : error(id, -32600, "Invalid request");
  }

  switch (method) {
    case "initialize": {
      const protocolVersion = msg.params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
      return result(id, {
        protocolVersion,
        capabilities: capabilities(ctx),
        serverInfo: ctx.serverInfo
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: ctx.tools });
    case "tools/call": {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = ctx.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return error(id, -32602, `Unknown tool: ${name}`);
      }
      const execution = await ctx.execute(name, args);
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
        return id === null ? null : error(id, -32601, "Method not found");
      }
      return result(id, { resources: await ctx.resources() });
    }
    case "resources/read": {
      if (!ctx.resources || !ctx.readResource) {
        return id === null ? null : error(id, -32601, "Method not found");
      }
      const uri = msg.params?.uri;
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
        return id === null ? null : error(id, -32601, "Method not found");
      }
      return result(id, { prompts: ctx.prompts });
    }
    case "prompts/get": {
      if (!ctx.prompts || !ctx.getPrompt) {
        return id === null ? null : error(id, -32601, "Method not found");
      }
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string" || name.length === 0) {
        return error(id, -32602, "Prompt name must be a non-empty string");
      }
      if (!ctx.prompts.some((prompt) => prompt.name === name)) {
        return error(id, -32602, `Unknown prompt: ${name}`);
      }
      const prompt = await ctx.getPrompt(name, args);
      if (!prompt) {
        return error(id, -32602, `Invalid arguments for prompt: ${name}`);
      }
      return result(id, prompt);
    }
    default:
      // Unknown method: answer addressable requests, ignore notifications.
      return id === null ? null : error(id, -32601, "Method not found");
  }
}

/**
 * Run the newline-delimited JSON-RPC 2.0 stdio loop. stdout is the protocol
 * channel (one JSON object per line); all diagnostics go to stderr. Resolves
 * when stdin closes.
 */
export async function runStdioServer(ctx: McpContext): Promise<void> {
  const rl = createInterface({ input: process.stdin });

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        return;
      }

      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        process.stderr.write("visp-hyper mcp: parse error on incoming line\n");
        process.stdout.write(`${JSON.stringify(error(null, -32700, "Parse error"))}\n`);
        return;
      }

      // Dispatch asynchronously; preserve write ordering by chaining writes.
      void handleMessage(ctx, parsed)
        .then((response) => {
          if (response !== null) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(`visp-hyper mcp: handler error: ${message}\n`);
        });
    });

    rl.on("close", () => {
      resolve();
    });
  });
}
