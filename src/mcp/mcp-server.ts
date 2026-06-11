import { createInterface } from "node:readline";

/**
 * A single MCP tool advertised over `tools/list` and invocable via `tools/call`.
 * `inputSchema` is a JSON Schema object describing the tool's `arguments`.
 */
export type McpToolDef = { name: string; description: string; inputSchema: object };

/**
 * Everything the protocol core needs to answer requests: the tool table, an
 * executor that runs a named tool and returns its captured text, and the
 * server identity echoed back during `initialize`.
 */
export type McpContext = {
  tools: McpToolDef[];
  execute: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
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
        capabilities: { tools: {} },
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
      if (!ctx.tools.some((tool) => tool.name === name)) {
        return error(id, -32602, `Unknown tool: ${name}`);
      }
      const { text, isError } = await ctx.execute(name, args);
      return result(id, { content: [{ type: "text", text }], isError });
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
