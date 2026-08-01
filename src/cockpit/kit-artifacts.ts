import type { CockpitKitArtifactReader } from "./artifact-state.js";

export const COCKPIT_KIT_ARTIFACTS_MODULE_ID = "visp-kit/artifacts" as const;

const REQUIRED_READER_METHODS = Object.freeze([
  "projectProfile",
  "projectConfig",
  "projectStatus",
  "policy",
  "workflowManifest",
  "featureIntent",
  "specification",
  "plan",
  "taskGraph",
  "verification",
  "taskReview",
  "assuranceCase",
  "currentReviewDecision",
  "reviewDecision",
  "runIndex",
  "constitution",
  "patterns",
  "projectSummary",
  "doctorReport"
] as const satisfies readonly (keyof CockpitKitArtifactReader)[]);

export type CockpitRunEvent = Readonly<{
  runId: string;
  [key: string]: unknown;
}>;

export type CockpitKitArtifacts = Readonly<{
  reader: CockpitKitArtifactReader;
  validateRunEvent: (candidate: unknown) => CockpitRunEvent;
}>;

export type CockpitKitModuleLoader = (specifier: string) => Promise<unknown>;

export class CockpitKitArtifactsError extends Error {
  readonly code: "module_unavailable" | "incompatible_module";

  constructor(
    code: CockpitKitArtifactsError["code"],
    message: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CockpitKitArtifactsError";
    this.code = code;
  }
}

export async function loadCockpitKitArtifacts(
  projectPath: string,
  loadModule: CockpitKitModuleLoader = defaultModuleLoader
): Promise<CockpitKitArtifacts> {
  let candidate: unknown;
  try {
    candidate = await loadModule(COCKPIT_KIT_ARTIFACTS_MODULE_ID);
  } catch (error) {
    throw new CockpitKitArtifactsError(
      "module_unavailable",
      "Cockpit requires a compatible visp-kit artifact reader in this project.",
      error
    );
  }

  if (!isRecord(candidate) || typeof candidate.createArtifactReader !== "function") {
    throw incompatibleModule();
  }
  const schemas = candidate.artifactSchemas;
  if (!isRecord(schemas) || !hasParser(schemas.runEvent)) throw incompatibleModule();

  let reader: unknown;
  try {
    reader = candidate.createArtifactReader(projectPath);
  } catch (error) {
    throw new CockpitKitArtifactsError(
      "incompatible_module",
      "Cockpit could not create the installed Kit artifact reader.",
      error
    );
  }
  if (!isReader(reader)) throw incompatibleModule();

  const runEventSchema = schemas.runEvent;
  const validateRunEvent = (value: unknown): CockpitRunEvent => {
    const event: unknown = runEventSchema.parse(value);
    if (!isRecord(event) || typeof event.runId !== "string" || event.runId.length === 0) {
      throw new TypeError("Kit returned a run event without its run ID.");
    }
    return event as CockpitRunEvent;
  };

  return Object.freeze({ reader, validateRunEvent });
}

async function defaultModuleLoader(specifier: string): Promise<unknown> {
  return import(specifier);
}

function isReader(value: unknown): value is CockpitKitArtifactReader {
  return (
    isRecord(value) &&
    REQUIRED_READER_METHODS.every((method) => typeof value[method] === "function")
  );
}

function hasParser(value: unknown): value is Readonly<{ parse: (candidate: unknown) => unknown }> {
  return isRecord(value) && typeof value.parse === "function";
}

function incompatibleModule(): CockpitKitArtifactsError {
  return new CockpitKitArtifactsError(
    "incompatible_module",
    "Installed visp-kit does not expose the Cockpit artifact-reader contract."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
