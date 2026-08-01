import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, realpath } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import {
  readCockpitState,
  type CockpitKitReadOptions,
  type CockpitKitReadState,
  type CockpitStaleAfterResolver
} from "./artifact-state.js";
import {
  COCKPIT_API_PATHS,
  cockpitApiError,
  cockpitArtifactPath,
  type CockpitApiErrorV1,
  type CockpitArtifactPath
} from "./contracts.js";
import {
  loadCockpitKitArtifacts,
  type CockpitKitArtifacts,
  type CockpitKitModuleLoader
} from "./kit-artifacts.js";
import {
  CockpitRunsError,
  paginateCockpitRuns,
  parseCockpitRunEventsRequest,
  parseCockpitRunsPageRequest,
  tailRunEvents,
  type CockpitRunIndexEntryLike
} from "./runs.js";
import {
  assertCockpitBindHost,
  COCKPIT_BIND_HOST,
  cockpitSessionTokenMatches,
  expectedCockpitHostHeader,
  generateCockpitSessionToken,
  isValidCockpitHostHeader,
  readCockpitBearerToken
} from "./security.js";
import { createCockpitSseBroadcaster } from "./sse.js";
import {
  COCKPIT_CSS,
  COCKPIT_DOCUMENT_HEADERS,
  COCKPIT_HTML,
  COCKPIT_JAVASCRIPT,
  COCKPIT_SCRIPT_PATH,
  COCKPIT_STYLE_PATH
} from "./ui.js";
import { startCockpitWatcher } from "./watcher.js";

const RUN_INDEX_PATH = cockpitArtifactPath(".visp/runs/index.json");
const DEFAULT_SSE_KEEP_ALIVE_MS = 15_000;

const BASE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
} as const);

export type StartCockpitServerOptions = Readonly<{
  projectPath: string;
  host?: string;
  port?: number;
  staleAfter?: CockpitStaleAfterResolver;
  kitArtifacts?: CockpitKitArtifacts;
  loadKitModule?: CockpitKitModuleLoader;
  sseKeepAliveMs?: number;
}>;

export type CockpitServer = Readonly<{
  host: typeof COCKPIT_BIND_HOST;
  port: number;
  url: string;
  token: string;
  close: () => Promise<void>;
}>;

type RequestContext = Readonly<{
  projectPath: string;
  projectIdentity: Readonly<{ device: number; inode: number }>;
  port: number;
  token: string;
  kit: CockpitKitArtifacts;
  staleAfter?: CockpitStaleAfterResolver;
  addSseClient: (response: ServerResponse) => () => void;
}>;

export async function startCockpitServer(
  options: StartCockpitServerOptions
): Promise<CockpitServer> {
  const host = options.host ?? COCKPIT_BIND_HOST;
  assertCockpitBindHost(host);
  const requestedPort = validatePort(options.port ?? 0);
  if (options.kitArtifacts !== undefined && options.loadKitModule !== undefined) {
    throw new TypeError("Provide either kitArtifacts or loadKitModule, not both.");
  }

  const projectPath = await realpath(resolve(options.projectPath));
  const projectStats = await lstat(projectPath);
  if (!projectStats.isDirectory() || projectStats.isSymbolicLink()) {
    throw new TypeError("Cockpit projectPath must resolve to a directory.");
  }
  const projectIdentity = Object.freeze({
    device: projectStats.dev,
    inode: projectStats.ino
  });
  const kit =
    options.kitArtifacts ??
    (await loadCockpitKitArtifacts(projectPath, options.loadKitModule));
  const token = generateCockpitSessionToken();
  const sse = createCockpitSseBroadcaster({
    keepAliveMs: options.sseKeepAliveMs ?? DEFAULT_SSE_KEEP_ALIVE_MS
  });
  let watcher: Awaited<ReturnType<typeof startCockpitWatcher>>;
  try {
    watcher = await startCockpitWatcher({
      projectPath,
      onInvalidate: (path) => {
        if (path === ".visp") sse.invalidate(path);
        else sse.invalidate(cockpitArtifactPath(path));
      },
      onError: () => {
        sse.invalidate(".visp");
      }
    });
  } catch (error) {
    sse.close();
    throw error;
  }

  let actualPort = 0;
  const httpServer = createServer((request, response) => {
    const context: RequestContext = {
      projectPath,
      projectIdentity,
      port: actualPort,
      token,
      kit,
      staleAfter: options.staleAfter,
      addSseClient: sse.addClient
    };
    void handleRequest(request, response, context).catch((error) => {
      sendUnhandledError(response, error);
    });
  });
  httpServer.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  try {
    await listen(httpServer, requestedPort, host);
  } catch (error) {
    sse.close();
    await watcher.close();
    throw error;
  }

  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    sse.close();
    await watcher.close();
    await closeHttpServer(httpServer);
    throw new Error("Cockpit listener did not report its loopback port.");
  }
  actualPort = (address as AddressInfo).port;
  const url = `http://${COCKPIT_BIND_HOST}:${actualPort}/?token=${encodeURIComponent(token)}`;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closePromise = (async () => {
      sse.close();
      await watcher.close();
      const closing = closeHttpServer(httpServer);
      httpServer.closeIdleConnections();
      httpServer.closeAllConnections();
      await closing;
    })();
    return closePromise;
  };

  return Object.freeze({ host: COCKPIT_BIND_HOST, port: actualPort, url, token, close });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext
): Promise<void> {
  if (!isValidCockpitHostHeader(request.headers.host, context.port)) {
    sendJson(response, 403, cockpitApiError("forbidden", "Cockpit Host header is invalid."));
    return;
  }

  const requestUrl = parseRequestUrl(request.url, context.port);
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, cockpitApiError("not_found", "Cockpit route is read-only."));
    return;
  }

  if (requestUrl.pathname === COCKPIT_STYLE_PATH) {
    sendText(response, 200, "text/css; charset=utf-8", COCKPIT_CSS);
    return;
  }
  if (requestUrl.pathname === COCKPIT_SCRIPT_PATH) {
    sendText(response, 200, "text/javascript; charset=utf-8", COCKPIT_JAVASCRIPT);
    return;
  }
  if (requestUrl.pathname === "/favicon.ico") {
    sendText(response, 204, "image/x-icon", "");
    return;
  }

  const permitsQueryToken =
    requestUrl.pathname === "/" || requestUrl.pathname === COCKPIT_API_PATHS.events;
  if (!isAuthorized(request, requestUrl, context.token, permitsQueryToken)) {
    sendJson(response, 401, cockpitApiError("unauthorized", "Cockpit token is required."));
    return;
  }

  if (requestUrl.pathname === "/") {
    if (!hasOnlyQueryKeys(requestUrl.searchParams, ["token"]) || hasDuplicateToken(requestUrl)) {
      sendJson(response, 400, cockpitApiError("bad_request", "Cockpit URL query is invalid."));
      return;
    }
    sendText(response, 200, "text/html; charset=utf-8", COCKPIT_HTML, COCKPIT_DOCUMENT_HEADERS);
    return;
  }
  if (requestUrl.pathname === COCKPIT_API_PATHS.state) {
    if (requestUrl.search.length !== 0) {
      sendJson(response, 400, cockpitApiError("bad_request", "State endpoint has no query."));
      return;
    }
    await assertPinnedProjectRoot(context);
    const state = await readCockpitState({
      projectPath: context.projectPath,
      reader: context.kit.reader,
      staleAfter: context.staleAfter
    });
    await assertPinnedProjectRoot(context);
    sendJson(response, 200, state);
    return;
  }
  if (requestUrl.pathname === COCKPIT_API_PATHS.events) {
    if (!hasOnlyQueryKeys(requestUrl.searchParams, ["token"]) || hasDuplicateToken(requestUrl)) {
      sendJson(response, 400, cockpitApiError("bad_request", "Event stream query is invalid."));
      return;
    }
    openEventStream(request, response, context.addSseClient);
    return;
  }
  if (requestUrl.pathname === COCKPIT_API_PATHS.runs) {
    await assertPinnedProjectRoot(context);
    const pageRequest = parseCockpitRunsPageRequest(requestUrl.searchParams);
    const runs = await readRunIndex(context);
    const page = paginateCockpitRuns(runs, RUN_INDEX_PATH, pageRequest);
    await assertPinnedProjectRoot(context);
    sendJson(response, 200, page);
    return;
  }

  const runEventsMatch = /^\/api\/runs\/([^/]+)\/events$/u.exec(requestUrl.pathname);
  if (runEventsMatch !== null) {
    await assertPinnedProjectRoot(context);
    let runId: string;
    try {
      runId = decodeURIComponent(runEventsMatch[1]!);
    } catch (error) {
      throw new CockpitRunsError(
        400,
        "bad_request",
        "Cockpit run ID encoding is invalid.",
        undefined,
        error
      );
    }
    const tailRequest = parseCockpitRunEventsRequest(requestUrl.searchParams);
    const events = await tailRunEvents({
      projectPath: context.projectPath,
      runId,
      offset: tailRequest.offset,
      generation: tailRequest.generation,
      validateEvent: context.kit.validateRunEvent
    });
    await assertPinnedProjectRoot(context);
    sendJson(response, 200, events);
    return;
  }

  sendJson(response, 404, cockpitApiError("not_found", "Cockpit route was not found."));
}

async function assertPinnedProjectRoot(context: RequestContext): Promise<void> {
  const current = await lstat(context.projectPath);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== context.projectIdentity.device ||
    current.ino !== context.projectIdentity.inode
  ) {
    throw new Error("Cockpit project root changed after startup.");
  }
}

async function readRunIndex(context: RequestContext): Promise<readonly CockpitRunIndexEntryLike[]> {
  let state: CockpitKitReadState;
  const options = kitReadOptions(context.staleAfter?.(RUN_INDEX_PATH));
  try {
    state = await context.kit.reader.runIndex(options);
  } catch (error) {
    throw runIndexError(
      500,
      "internal_error",
      "Run index is unavailable.",
      "unavailable",
      error
    );
  }
  if (!matchesExpectedPath(context.projectPath, state.path, RUN_INDEX_PATH)) {
    throw runIndexError(
      500,
      "internal_error",
      "Run index provenance is incompatible.",
      "unavailable"
    );
  }
  if (state.state === "missing") {
    const uninitialized = await artifactRootIsAbsent(context.projectPath);
    throw new CockpitRunsError(
      404,
      "not_found",
      uninitialized ? "Run index is unavailable before Kit initialization." : "Run index is missing.",
      Object.freeze({
        state: uninitialized ? ("uninitialized" as const) : ("missing" as const),
        expectedPath: RUN_INDEX_PATH
      })
    );
  }
  if (state.state === "stale") {
    throw runIndexError(409, "conflict", "Run index is stale.", "stale");
  }
  if (state.state === "unreadable") {
    const corrupt = state.issue === "invalid_json" || state.issue === "invalid_schema";
    throw runIndexError(
      corrupt ? 422 : 500,
      corrupt ? "unprocessable" : "internal_error",
      corrupt ? "Run index is corrupt." : "Run index is unavailable.",
      corrupt ? "corrupt" : "unavailable"
    );
  }
  if (!isRecord(state.value) || !Array.isArray(state.value.runs)) {
    throw runIndexError(
      500,
      "internal_error",
      "Run index shape is incompatible.",
      "unavailable"
    );
  }
  const runs = state.value.runs;
  if (!runs.every(isRunIndexEntry)) {
    throw runIndexError(
      500,
      "internal_error",
      "Run index entries are incompatible.",
      "unavailable"
    );
  }
  return runs;
}

function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  addClient: RequestContext["addSseClient"]
): void {
  response.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
  const detach = addClient(response);
  request.once("close", detach);
  response.once("close", detach);
}

function isAuthorized(
  request: IncomingMessage,
  requestUrl: URL,
  expectedToken: string,
  permitsQueryToken: boolean
): boolean {
  const bearer = readCockpitBearerToken(request.headers.authorization);
  if (bearer !== undefined && cockpitSessionTokenMatches(expectedToken, bearer)) return true;
  if (!permitsQueryToken) return false;
  const queryTokens = requestUrl.searchParams.getAll("token");
  return (
    queryTokens.length === 1 &&
    queryTokens[0] !== undefined &&
    cockpitSessionTokenMatches(expectedToken, queryTokens[0])
  );
}

function sendUnhandledError(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.writableEnded) {
    if (!response.writableEnded) response.end();
    return;
  }
  if (error instanceof CockpitRunsError) {
    sendJson(response, error.statusCode, error.publicError);
    return;
  }
  sendJson(
    response,
    500,
    cockpitApiError("internal_error", "Cockpit could not complete this local request.")
  );
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  sendText(response, statusCode, "application/json; charset=utf-8", JSON.stringify(value));
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headers: Readonly<Record<string, string>> = {}
): void {
  if (response.writableEnded) return;
  response.writeHead(statusCode, {
    ...BASE_HEADERS,
    ...headers,
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function runIndexError(
  statusCode: CockpitRunsError["statusCode"],
  code: CockpitApiErrorV1["error"]["code"],
  message: string,
  state: "stale" | "corrupt" | "unavailable",
  cause?: unknown
): CockpitRunsError {
  const artifact =
    state === "unavailable"
      ? Object.freeze({ state, expectedPath: RUN_INDEX_PATH, sourcePath: RUN_INDEX_PATH })
      : Object.freeze({ state, expectedPath: RUN_INDEX_PATH, sourcePath: RUN_INDEX_PATH });
  return new CockpitRunsError(statusCode, code, message, artifact, cause);
}

function isRunIndexEntry(value: unknown): value is CockpitRunIndexEntryLike {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.startedAt === "string" &&
    value.startedAt.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kitReadOptions(staleAfter: Date | undefined): CockpitKitReadOptions | undefined {
  return staleAfter === undefined ? undefined : Object.freeze({ staleAfter });
}

function matchesExpectedPath(
  projectPath: string,
  actualPath: string,
  expectedPath: CockpitArtifactPath
): boolean {
  return resolve(actualPath) === resolve(projectPath, expectedPath);
}

function parseRequestUrl(requestUrl: string | undefined, port: number): URL {
  try {
    return new URL(requestUrl ?? "/", `http://${expectedCockpitHostHeader(port)}`);
  } catch (error) {
    throw new CockpitRunsError(
      400,
      "bad_request",
      "Cockpit request URL is invalid.",
      undefined,
      error
    );
  }
}

function hasOnlyQueryKeys(searchParams: URLSearchParams, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return [...searchParams.keys()].every((key) => allowedKeys.has(key));
}

function hasDuplicateToken(requestUrl: URL): boolean {
  return requestUrl.searchParams.getAll("token").length > 1;
}

async function artifactRootIsAbsent(projectPath: string): Promise<boolean> {
  try {
    await lstat(resolve(projectPath, ".visp"));
    return false;
  } catch (error) {
    return isNodeError(error, "ENOENT");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Cockpit port must be an integer from 0 through 65535.");
  }
  return port;
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: typeof COCKPIT_BIND_HOST
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
}

function closeHttpServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolvePromise();
    });
  });
}
