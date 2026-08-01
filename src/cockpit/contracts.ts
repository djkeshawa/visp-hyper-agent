import { assertSafeCockpitRunId } from "./path-security.js";

export const COCKPIT_API_VERSION = "1.0" as const;

export const COCKPIT_NAVIGATION = Object.freeze([
  Object.freeze({ id: "now", label: "Now" }),
  Object.freeze({ id: "feature", label: "Feature" }),
  Object.freeze({ id: "scope", label: "Scope" }),
  Object.freeze({ id: "assurance", label: "Assurance" }),
  Object.freeze({ id: "review", label: "Review" }),
  Object.freeze({ id: "runs", label: "Runs" }),
  Object.freeze({ id: "memory", label: "Memory" }),
  Object.freeze({ id: "health", label: "Health" }),
  Object.freeze({ id: "reference", label: "Reference" })
] as const);

export const COCKPIT_API_PATHS = Object.freeze({
  state: "/api/state",
  events: "/api/events",
  runs: "/api/runs"
} as const);

export type CockpitApiVersion = typeof COCKPIT_API_VERSION;
export type CockpitScreenDefinition = (typeof COCKPIT_NAVIGATION)[number];
export type CockpitScreenId = CockpitScreenDefinition["id"];
export type CockpitArtifactStateName =
  | "present"
  | "uninitialized"
  | "missing"
  | "stale"
  | "corrupt"
  | "unavailable";

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
export type CockpitArtifactScalar = string | number | boolean | null;

declare const cockpitArtifactPathBrand: unique symbol;
export type CockpitArtifactPath = string & {
  readonly [cockpitArtifactPathBrand]: "CockpitArtifactPath";
};

export function isCockpitArtifactPath(value: unknown): value is CockpitArtifactPath {
  if (typeof value !== "string" || !value.startsWith(".visp/")) return false;
  if (
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%")
  ) {
    return false;
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) return false;
  const segments = value.split("/");
  return (
    segments.length > 1 &&
    segments[0] === ".visp" &&
    segments.slice(1).every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function cockpitArtifactPath<const Path extends string>(
  value: Path
): Path & CockpitArtifactPath {
  if (!isCockpitArtifactPath(value)) {
    throw new TypeError(
      "Cockpit artifact path must be a repository-relative POSIX path below .visp/."
    );
  }
  return value as Path & CockpitArtifactPath;
}

export const COCKPIT_MEMORY_ARTIFACT_PATHS = Object.freeze([
  cockpitArtifactPath(".visp/memory/constitution.md"),
  cockpitArtifactPath(".visp/memory/patterns.md"),
  cockpitArtifactPath(".visp/memory/project-summary.md")
] as const);

export type CockpitMemoryArtifactPath = (typeof COCKPIT_MEMORY_ARTIFACT_PATHS)[number];

type CockpitSourcePath<Id extends CockpitScreenId> = Id extends "memory"
  ? CockpitMemoryArtifactPath
  : CockpitArtifactPath;

/** A displayed artifact value. The UI renders sourcePath beside value. */
export type CockpitArtifactValue<SourcePath extends CockpitArtifactPath = CockpitArtifactPath> =
  Readonly<{
    label: string;
    value: CockpitArtifactScalar;
    sourcePath: SourcePath;
  }>;

type CockpitArtifactIdentity = Readonly<{
  id: string;
  label: string;
}>;

export type CockpitPresentArtifact<
  SourcePath extends CockpitArtifactPath = CockpitArtifactPath
> = CockpitArtifactIdentity &
  Readonly<{
    state: "present";
    sourcePath: SourcePath;
    values: NonEmptyReadonlyArray<CockpitArtifactValue<SourcePath>>;
  }>;

export type CockpitExpectedArtifact<
  SourcePath extends CockpitArtifactPath = CockpitArtifactPath
> = CockpitArtifactIdentity &
  Readonly<{
    state: "uninitialized" | "missing" | "unavailable";
    reason: string;
    expectedPath: SourcePath;
    sourcePath?: SourcePath;
  }>;

export type CockpitExistingDegradedArtifact<
  SourcePath extends CockpitArtifactPath = CockpitArtifactPath
> = CockpitArtifactIdentity &
  Readonly<{
    state: "stale" | "corrupt";
    reason: string;
    expectedPath: SourcePath;
    sourcePath: SourcePath;
  }>;

export type CockpitArtifactView<
  SourcePath extends CockpitArtifactPath = CockpitArtifactPath
> =
  | CockpitPresentArtifact<SourcePath>
  | CockpitExpectedArtifact<SourcePath>
  | CockpitExistingDegradedArtifact<SourcePath>;

type ScreenLabelById = {
  [Definition in CockpitScreenDefinition as Definition["id"]]: Definition["label"];
};

export type CockpitScreen<Id extends CockpitScreenId = CockpitScreenId> = Readonly<{
  id: Id;
  label: ScreenLabelById[Id];
  artifacts: NonEmptyReadonlyArray<CockpitArtifactView<CockpitSourcePath<Id>>>;
}>;

export type CockpitScreenMap = {
  readonly [Id in CockpitScreenId]: CockpitScreen<Id>;
};

/** Commands are opaque artifact values. Browser behavior is copy-only. */
export type CockpitArtifactCommand = Readonly<{
  label: string;
  command: string;
  sourcePath: CockpitArtifactPath;
}>;

export type CockpitCommandPalette =
  | Readonly<{
      state: "present";
      sourcePath: CockpitArtifactPath;
      commands: NonEmptyReadonlyArray<CockpitArtifactCommand>;
    }>
  | Readonly<{
      state: "unavailable";
      reason: string;
      expectedPath: CockpitArtifactPath;
      sourcePath?: CockpitArtifactPath;
    }>;

export type CockpitStateV1 = Readonly<{
  apiVersion: CockpitApiVersion;
  screens: CockpitScreenMap;
  commandPalette: CockpitCommandPalette;
}>;

declare const cockpitByteOffsetBrand: unique symbol;
export type CockpitByteOffset = number & {
  readonly [cockpitByteOffsetBrand]: "CockpitByteOffset";
};

export function cockpitByteOffset(value: number): CockpitByteOffset {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Cockpit byte offset must be a non-negative safe integer.");
  }
  return value as CockpitByteOffset;
}

declare const cockpitRunGenerationBrand: unique symbol;
export type CockpitRunGeneration = string & {
  readonly [cockpitRunGenerationBrand]: "CockpitRunGeneration";
};

export const COCKPIT_RUN_GENERATION_MAX_LENGTH = 256 as const;

export function cockpitRunGeneration(value: string): CockpitRunGeneration {
  if (
    value.length === 0 ||
    value.length > COCKPIT_RUN_GENERATION_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Cockpit run generation must be a bounded nonempty opaque string.");
  }
  return value as CockpitRunGeneration;
}

export type CockpitRunsPageV1<Run = unknown> = Readonly<{
  apiVersion: CockpitApiVersion;
  kind: "runs-page";
  sourcePath: CockpitArtifactPath;
  runs: readonly Run[];
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
}>;

export type CockpitRunEventsPageV1<RunEvent = unknown> = Readonly<{
  apiVersion: CockpitApiVersion;
  kind: "run-events-page";
  runId: string;
  sourcePath: CockpitArtifactPath;
  events: readonly RunEvent[];
  offset: CockpitByteOffset;
  nextOffset: CockpitByteOffset;
  rotated: boolean;
  generation: CockpitRunGeneration;
}>;

export type CockpitRunsPageRequest = Readonly<{
  offset?: number;
  limit?: number;
}>;

export type CockpitRunEventsRequest = Readonly<{
  offset: CockpitByteOffset;
  generation?: CockpitRunGeneration;
}>;

export function cockpitRunsPagePath(request: CockpitRunsPageRequest = {}): string {
  const offset = request.offset ?? 0;
  const limit = request.limit ?? 64;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new TypeError("Cockpit runs offset must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Cockpit runs limit must be a positive safe integer.");
  }
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  return `${COCKPIT_API_PATHS.runs}?${query.toString()}`;
}

export function cockpitRunEventsPath(runId: string, request: CockpitRunEventsRequest): string {
  const safeRunId = assertSafeCockpitRunId(runId);
  const query = new URLSearchParams({ offset: String(cockpitByteOffset(request.offset)) });
  if (request.generation !== undefined) {
    query.set("generation", cockpitRunGeneration(request.generation));
  }
  return `${COCKPIT_API_PATHS.runs}/${encodeURIComponent(safeRunId)}/events?${query.toString()}`;
}

export const COCKPIT_ERROR_MESSAGE_MAX_LENGTH = 512 as const;
export type CockpitApiErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unprocessable"
  | "internal_error";

export type CockpitApiErrorV1 = Readonly<{
  apiVersion: CockpitApiVersion;
  kind: "error";
  error: Readonly<{
    code: CockpitApiErrorCode;
    message: string;
    artifact?: CockpitApiErrorArtifact;
  }>;
}>;

export type CockpitApiErrorArtifact =
  | Readonly<{
      state: "uninitialized" | "missing" | "unavailable";
      expectedPath: CockpitArtifactPath;
      sourcePath?: CockpitArtifactPath;
    }>
  | Readonly<{
      state: "stale" | "corrupt";
      expectedPath: CockpitArtifactPath;
      sourcePath: CockpitArtifactPath;
    }>;

export function cockpitApiError(
  code: CockpitApiErrorCode,
  message: string,
  artifact?: CockpitApiErrorArtifact
): CockpitApiErrorV1 {
  const boundedMessage = message.trim().slice(0, COCKPIT_ERROR_MESSAGE_MAX_LENGTH);
  const boundedError = artifact === undefined
    ? { code, message: boundedMessage || "Cockpit request failed." }
    : {
        code,
        message: boundedMessage || "Cockpit request failed.",
        artifact: freezeErrorArtifact(artifact)
      };
  return Object.freeze({
    apiVersion: COCKPIT_API_VERSION,
    kind: "error",
    error: Object.freeze(boundedError)
  });
}

function freezeErrorArtifact(artifact: CockpitApiErrorArtifact): CockpitApiErrorArtifact {
  if (
    artifact.state !== "uninitialized" &&
    artifact.state !== "missing" &&
    artifact.state !== "stale" &&
    artifact.state !== "corrupt" &&
    artifact.state !== "unavailable"
  ) {
    throw new TypeError("Cockpit API error artifact state must be an explicit degraded state.");
  }
  if (!isCockpitArtifactPath(artifact.expectedPath)) {
    throw new TypeError("Cockpit API error expectedPath must be a valid artifact path.");
  }
  if (artifact.sourcePath !== undefined && !isCockpitArtifactPath(artifact.sourcePath)) {
    throw new TypeError("Cockpit API error sourcePath must be a valid artifact path.");
  }
  if (
    (artifact.state === "stale" || artifact.state === "corrupt") &&
    artifact.sourcePath === undefined
  ) {
    throw new TypeError("Cockpit stale or corrupt API errors must identify their source path.");
  }
  return Object.freeze({ ...artifact });
}

export type CockpitInvalidationV1 = Readonly<{
  apiVersion: CockpitApiVersion;
  type: "invalidation";
  path: CockpitArtifactPath | ".visp";
}>;
