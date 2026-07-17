import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo, type Socket } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface RouteResponse {
  /** HTTP status code (default 200). */
  status?: number;
  /** JSON body to return. Mutually exclusive with `raw`. */
  json?: unknown;
  /** Raw string body (use for malformed-JSON tests). */
  raw?: string;
}

/**
 * Route key is `"<METHOD> <pathname>"`, e.g. `"POST /recall"` or `"GET /healthz"`.
 * A function receives the recorded request and returns the response to send.
 */
export type RouteSpec = Record<string, RouteResponse | ((req: RecordedRequest) => RouteResponse)>;

export interface MockMemoryServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Starts an ephemeral (port 0) HTTP server that records every request and
 * answers from `spec`. Unmatched routes return 404.
 */
export async function startMockMemoryServer(spec: RouteSpec): Promise<MockMemoryServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url ?? "/", "http://localhost");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname + url.search,
        headers: req.headers,
        body: parseBody(rawBody)
      };
      requests.push(recorded);

      const key = `${recorded.method} ${url.pathname}`;
      const entry = spec[key];
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: `no route for ${key}` }));
        return;
      }
      const response = typeof entry === "function" ? entry(recorded) : entry;
      res.writeHead(response.status ?? 200, { "content-type": "application/json" });
      if (response.raw !== undefined) {
        res.end(response.raw);
      } else {
        res.end(JSON.stringify(response.json ?? null));
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => closeServer(server, sockets)
  };
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function closeServer(server: Server, sockets: ReadonlySet<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  // Fetch keeps HTTP connections alive. Destroy only fixture-owned sockets so
  // the close callback is deterministic under captured and terminal output.
  for (const socket of sockets) {
    socket.destroy();
  }
  return closed;
}
