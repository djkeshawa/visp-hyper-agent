import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";

import {
  COCKPIT_API_VERSION,
  cockpitApiError,
  cockpitArtifactPath,
  cockpitByteOffset,
  cockpitRunGeneration,
  isCockpitArtifactPath,
  type CockpitApiErrorArtifact,
  type CockpitApiErrorCode,
  type CockpitApiErrorV1,
  type CockpitArtifactPath,
  type CockpitByteOffset,
  type CockpitRunEventsPageV1,
  type CockpitRunGeneration,
  type CockpitRunsPageRequest,
  type CockpitRunsPageV1
} from "./contracts.js";
import {
  assertSafeCockpitRunId,
  resolveContainedExistingPath
} from "./path-security.js";

export const COCKPIT_RUNS_DEFAULT_LIMIT = 64 as const;
export const COCKPIT_RUNS_MAX_LIMIT = 100 as const;
export const COCKPIT_RUN_TAIL_MAX_BYTES = 1024 * 1024;
export const COCKPIT_RUN_GENERATION_FINGERPRINT_MAX_BYTES = 64 * 1024;
const RUN_EVENTS_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

export type CockpitRunIndexEntryLike = Readonly<{
  id: string;
  startedAt: string;
}>;

export type ParsedCockpitRunsPageRequest = Readonly<{
  offset: number;
  limit: number;
}>;

export type ParsedCockpitRunEventsRequest = Readonly<{
  offset: CockpitByteOffset;
  generation?: CockpitRunGeneration;
}>;

export class CockpitRunsError extends Error {
  readonly statusCode: 400 | 403 | 404 | 409 | 422 | 500;
  readonly publicError: CockpitApiErrorV1;

  constructor(
    statusCode: CockpitRunsError["statusCode"],
    code: CockpitApiErrorCode,
    message: string,
    artifact?: CockpitApiErrorArtifact,
    cause?: unknown
  ) {
    const publicError = cockpitApiError(code, message, artifact);
    super(publicError.error.message, cause === undefined ? undefined : { cause });
    this.name = "CockpitRunsError";
    this.statusCode = statusCode;
    this.publicError = publicError;
  }
}

export function parseCockpitRunsPageRequest(
  searchParams: URLSearchParams
): ParsedCockpitRunsPageRequest {
  assertOnlyQueryKeys(searchParams, ["offset", "limit"]);
  const offset = parseQueryInteger(searchParams, "offset", 0, false);
  const requestedLimit = parseQueryInteger(
    searchParams,
    "limit",
    COCKPIT_RUNS_DEFAULT_LIMIT,
    true
  );
  return Object.freeze({
    offset,
    limit: Math.min(requestedLimit, COCKPIT_RUNS_MAX_LIMIT)
  });
}

export function parseCockpitRunEventsRequest(
  searchParams: URLSearchParams
): ParsedCockpitRunEventsRequest {
  assertOnlyQueryKeys(searchParams, ["offset", "generation"]);
  const offset = cockpitByteOffset(parseQueryInteger(searchParams, "offset", 0, false));
  const generations = searchParams.getAll("generation");
  if (generations.length > 1) {
    throw badRequest("Cockpit run generation must be supplied at most once.");
  }
  if (generations.length === 0) return Object.freeze({ offset });

  try {
    return Object.freeze({ offset, generation: cockpitRunGeneration(generations[0]!) });
  } catch (error) {
    throw badRequest("Cockpit run generation is invalid.", error);
  }
}

export function paginateCockpitRuns<T extends CockpitRunIndexEntryLike>(
  runs: readonly T[],
  sourcePath: CockpitArtifactPath,
  request: CockpitRunsPageRequest = {}
): CockpitRunsPageV1<T> {
  if (!isCockpitArtifactPath(sourcePath)) {
    throw new TypeError("Cockpit Runs pagination requires valid artifact provenance.");
  }

  const offset = validatePageInteger("offset", request.offset ?? 0, false);
  const limit = Math.min(
    validatePageInteger("limit", request.limit ?? COCKPIT_RUNS_DEFAULT_LIMIT, true),
    COCKPIT_RUNS_MAX_LIMIT
  );
  const sorted = runs
    .map((run, index) => ({ run, index, startedAt: parseRunTimestamp(run) }))
    .sort((left, right) => {
      if (left.startedAt !== right.startedAt) return right.startedAt - left.startedAt;
      if (left.run.id !== right.run.id) return left.run.id < right.run.id ? 1 : -1;
      return right.index - left.index;
    })
    .map(({ run }) => run);
  const pageRuns = Object.freeze(sorted.slice(offset, offset + limit));
  const nextOffset = offset + pageRuns.length < sorted.length ? offset + pageRuns.length : null;

  return Object.freeze({
    apiVersion: COCKPIT_API_VERSION,
    kind: "runs-page",
    sourcePath,
    runs: pageRuns,
    offset,
    limit,
    total: sorted.length,
    nextOffset
  });
}

export type TailRunEventsOptions<T extends { readonly runId: string }> = Readonly<{
  projectPath: string;
  runId: string;
  offset: CockpitByteOffset;
  generation?: CockpitRunGeneration;
  validateEvent: (candidate: unknown) => T;
  maxReadBytes?: number;
}>;

export async function tailRunEvents<T extends { readonly runId: string }>(
  options: TailRunEventsOptions<T>
): Promise<CockpitRunEventsPageV1<T>> {
  let runId: string;
  try {
    runId = assertSafeCockpitRunId(options.runId);
  } catch (error) {
    throw badRequest("Run ID must be one safe path segment.", error);
  }

  const sourcePath = cockpitArtifactPath(`.visp/runs/${runId}/events.jsonl`);
  const requestedOffset = cockpitByteOffset(options.offset);
  const maxReadBytes = validateMaxReadBytes(options.maxReadBytes);
  const resolved = await resolveEventsPath(options.projectPath, sourcePath);
  let handle: FileHandle | undefined;

  try {
    handle = await open(resolved.absolutePath, RUN_EVENTS_OPEN_FLAGS);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw runArtifactError(
        422,
        "unprocessable",
        "Run events artifact is not a regular file.",
        sourcePath,
        "unavailable"
      );
    }
    await assertHandleStillNamesResolvedFile(
      options.projectPath,
      sourcePath,
      resolved.absolutePath,
      openedStats.dev,
      openedStats.ino
    );

    let offset = requestedOffset;
    let rotated = offset > openedStats.size;
    if (!rotated && options.generation !== undefined) {
      const requestedGeneration = await fingerprintRunGeneration(
        handle,
        openedStats,
        offset
      );
      rotated = options.generation !== requestedGeneration;
    }
    if (rotated) {
      offset = cockpitByteOffset(0);
    }

    await assertRecordBoundary(handle, offset);
    const availableBytes = Math.max(0, openedStats.size - offset);
    const bytesToRead = Math.min(availableBytes, maxReadBytes);
    const buffer = await readAtMost(handle, bytesToRead, offset);
    const finalNewline = buffer.lastIndexOf(0x0a);

    if (finalNewline < 0) {
      if (availableBytes > maxReadBytes) {
        throw runArtifactError(
          422,
          "unprocessable",
          `Run event record exceeds the ${maxReadBytes}-byte read limit.`,
          sourcePath,
          "unavailable"
        );
      }
      return Object.freeze({
        apiVersion: COCKPIT_API_VERSION,
        kind: "run-events-page",
        runId,
        sourcePath,
        events: Object.freeze([]) as readonly T[],
        offset,
        nextOffset: offset,
        rotated,
        generation: await fingerprintRunGeneration(
          handle,
          openedStats,
          offset
        )
      });
    }

    const completeBytes = buffer.subarray(0, finalNewline + 1);
    let decodedEvents: string;
    try {
      decodedEvents = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        completeBytes
      );
    } catch (error) {
      throw runArtifactError(
        422,
        "unprocessable",
        "Run events artifact contains invalid UTF-8.",
        sourcePath,
        "corrupt",
        error
      );
    }
    const lines = decodedEvents.split("\n");
    lines.pop();
    const events = Object.freeze(
      lines.map((line, index) => parseAndValidateEvent(line, index, runId, sourcePath, options))
    );
    const nextOffset = cockpitByteOffset(offset + completeBytes.byteLength);

    return Object.freeze({
      apiVersion: COCKPIT_API_VERSION,
      kind: "run-events-page",
      runId,
      sourcePath,
      events,
      offset,
      nextOffset,
      rotated,
      generation: await fingerprintRunGeneration(
        handle,
        openedStats,
        nextOffset
      )
    });
  } catch (error) {
    if (error instanceof CockpitRunsError) throw error;
    throw runArtifactError(
      500,
      "internal_error",
      "Run events artifact is unavailable.",
      sourcePath,
      "unavailable",
      error
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseAndValidateEvent<T extends { readonly runId: string }>(
  line: string,
  index: number,
  runId: string,
  sourcePath: CockpitArtifactPath,
  options: TailRunEventsOptions<T>
): T {
  if (line.length === 0) {
    throw runArtifactError(
      422,
      "unprocessable",
      `Run events artifact contains a blank complete record at line ${index + 1}.`,
      sourcePath
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch (error) {
    throw runArtifactError(
      422,
      "unprocessable",
      `Run events artifact contains malformed JSON at line ${index + 1}.`,
      sourcePath,
      "corrupt",
      error
    );
  }

  let event: T;
  try {
    event = options.validateEvent(candidate);
  } catch (error) {
    throw runArtifactError(
      422,
      "unprocessable",
      `Run events artifact failed schema validation at line ${index + 1}.`,
      sourcePath,
      "corrupt",
      error
    );
  }
  if (event.runId !== runId) {
    throw runArtifactError(
      422,
      "unprocessable",
      `Run event at line ${index + 1} does not belong to the requested run.`,
      sourcePath
    );
  }
  return event;
}

async function resolveEventsPath(
  projectPath: string,
  sourcePath: CockpitArtifactPath
): Promise<Awaited<ReturnType<typeof resolveContainedExistingPath>>> {
  try {
    return await resolveContainedExistingPath(projectPath, sourcePath, "any");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new CockpitRunsError(
        404,
        "not_found",
        "Run events artifact is missing.",
        Object.freeze({ state: "missing", expectedPath: sourcePath }),
        error
      );
    }
    if (error instanceof TypeError) {
      throw new CockpitRunsError(
        403,
        "forbidden",
        "Run events artifact is outside the permitted project boundary.",
        undefined,
        error
      );
    }
    throw error;
  }
}

async function assertHandleStillNamesResolvedFile(
  projectPath: string,
  sourcePath: CockpitArtifactPath,
  originallyResolvedPath: string,
  openedDevice: number,
  openedInode: number
): Promise<void> {
  let current: Awaited<ReturnType<typeof resolveContainedExistingPath>>;
  try {
    current = await resolveContainedExistingPath(projectPath, sourcePath, "file");
  } catch (error) {
    throw new CockpitRunsError(
      409,
      "conflict",
      "Run events artifact changed while it was being opened.",
      undefined,
      error
    );
  }
  if (current.absolutePath !== originallyResolvedPath) {
    throw new CockpitRunsError(
      409,
      "conflict",
      "Run events artifact changed while it was being opened."
    );
  }

  const comparisonHandle = await open(current.absolutePath, RUN_EVENTS_OPEN_FLAGS);
  try {
    const currentStats = await comparisonHandle.stat();
    if (currentStats.dev !== openedDevice || currentStats.ino !== openedInode) {
      throw new CockpitRunsError(
        409,
        "conflict",
        "Run events artifact changed while it was being opened."
      );
    }
  } finally {
    await comparisonHandle.close().catch(() => undefined);
  }
}

async function fingerprintRunGeneration(
  handle: FileHandle,
  stats: Stats,
  cursorOffset: CockpitByteOffset
): Promise<CockpitRunGeneration> {
  const fingerprintBytes = Math.min(stats.size, COCKPIT_RUN_GENERATION_FINGERPRINT_MAX_BYTES);
  const buffer = await readAtMost(handle, fingerprintBytes, 0);
  const firstNewline = buffer.indexOf(0x0a);
  // A valid first event may be larger than the fingerprint window. In that case
  // the bounded prefix still contributes stable replacement evidence without
  // imposing a second, undocumented record-size limit on Kit artifacts.
  const firstRecord = firstNewline < 0 ? buffer : buffer.subarray(0, firstNewline + 1);
  const cursorWindowLength = Math.min(
    cursorOffset,
    COCKPIT_RUN_GENERATION_FINGERPRINT_MAX_BYTES
  );
  const cursorWindow = await readAtMost(
    handle,
    cursorWindowLength,
    cursorOffset - cursorWindowLength
  );
  const digest = createHash("sha256")
    .update(`${stats.dev}:${stats.ino}:${cursorOffset}:`, "utf8")
    .update(firstRecord)
    .update("\0", "utf8")
    .update(cursorWindow)
    .digest("base64url");
  return cockpitRunGeneration(digest);
}

async function assertRecordBoundary(
  handle: FileHandle,
  offset: CockpitByteOffset
): Promise<void> {
  if (offset === 0) return;
  const previousByte = Buffer.allocUnsafe(1);
  const { bytesRead } = await handle.read(previousByte, 0, 1, offset - 1);
  if (bytesRead !== 1 || previousByte[0] !== 0x0a) {
    throw new CockpitRunsError(
      400,
      "bad_request",
      "Run event byte offset must point immediately after a complete record."
    );
  }
}

async function readAtMost(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

function runArtifactError(
  statusCode: CockpitRunsError["statusCode"],
  code: CockpitApiErrorCode,
  message: string,
  sourcePath: CockpitArtifactPath,
  state: "corrupt" | "unavailable" = "corrupt",
  cause?: unknown
): CockpitRunsError {
  return new CockpitRunsError(
    statusCode,
    code,
    message,
    Object.freeze({ state, expectedPath: sourcePath, sourcePath }),
    cause
  );
}

function validateMaxReadBytes(value: number | undefined): number {
  const resolved = value ?? COCKPIT_RUN_TAIL_MAX_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > COCKPIT_RUN_TAIL_MAX_BYTES) {
    throw badRequest(
      `Cockpit run tail read limit must be an integer from 1 through ${COCKPIT_RUN_TAIL_MAX_BYTES}.`
    );
  }
  return resolved;
}

function parseRunTimestamp(run: CockpitRunIndexEntryLike): number {
  const value = Date.parse(run.startedAt);
  if (Number.isNaN(value)) {
    throw new TypeError(`Run ${run.id} has an invalid startedAt timestamp.`);
  }
  return value;
}

function validatePageInteger(label: "offset" | "limit", value: number, positive: boolean): number {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(
      `Cockpit runs ${label} must be a ${positive ? "positive" : "non-negative"} safe integer.`
    );
  }
  return value;
}

function parseQueryInteger(
  searchParams: URLSearchParams,
  key: "offset" | "limit",
  defaultValue: number,
  positive: boolean
): number {
  const values = searchParams.getAll(key);
  if (values.length === 0) return defaultValue;
  if (values.length > 1 || !/^(?:0|[1-9][0-9]*)$/u.test(values[0]!)) {
    throw badRequest(`Cockpit runs ${key} must be supplied once as a base-10 integer.`);
  }
  const parsed = Number(values[0]);
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) {
    throw badRequest(
      `Cockpit runs ${key} must be a ${positive ? "positive" : "non-negative"} safe integer.`
    );
  }
  return parsed;
}

function assertOnlyQueryKeys(searchParams: URLSearchParams, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of searchParams.keys()) {
    if (!allowedKeys.has(key)) {
      throw badRequest(`Unknown Cockpit Runs query parameter: ${key}.`);
    }
  }
}

function badRequest(message: string, cause?: unknown): CockpitRunsError {
  return new CockpitRunsError(400, "bad_request", message, undefined, cause);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
