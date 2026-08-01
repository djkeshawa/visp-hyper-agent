import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";

import { z } from "zod";

import {
  type CockpitKitArtifactReader,
  type CockpitKitReadOptions,
  type CockpitKitReadState
} from "../../src/cockpit/artifact-state.js";
import { resolveContainedExistingPath } from "../../src/cockpit/path-security.js";

const NON_EMPTY_STRING = z.string().trim().min(1);
const ISO_DATE_TIME = z.string().datetime({ offset: true });
const SHA256 = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const REVIEW_DECISION_HASH_DOMAIN = "visp.review-decision\0canonical-1.0\0";
const READ_FLAGS =
  constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

// These fixture validators only keep host/security tests honest about corrupt
// documents. Exact Kit schema compatibility is covered by the packed-pair suite.
const projectProfileSchema = requiredRecord(
  "name",
  "rootPath",
  "packageManager",
  "languages",
  "createdAt",
  "updatedAt"
);
const projectConfigSchema = requiredRecord("schemaVersion", "projectId", "createdAt", "updatedAt");
const projectStatusSchema = requiredRecord(
  "initialized",
  "activeFeatureId",
  "currentState",
  "lastCommand",
  "createdAt",
  "updatedAt"
);
const policySchema = requiredRecord("version", "strictnessMode", "rules", "limits", "overrides");
const workflowSchema = requiredRecord("version", "generatedAt", "stages", "principles");
const featureIntentSchema = requiredRecord(
  "id",
  "slug",
  "title",
  "status",
  "rawUserRequest",
  "createdAt",
  "updatedAt"
);
const specificationSchema = requiredRecord(
  "featureId",
  "featureSlug",
  "title",
  "status",
  "createdAt",
  "updatedAt"
);
const planSchema = requiredRecord(
  "featureId",
  "featureSlug",
  "status",
  "implementationApproach",
  "createdAt",
  "updatedAt"
);
const taskGraphSchema = requiredRecord("featureId", "tasks", "createdAt", "updatedAt");
const verificationSchema = requiredRecord(
  "id",
  "featureId",
  "featureSlug",
  "taskId",
  "success",
  "summary",
  "nextCommand"
);
const taskReviewSchema = requiredRecord(
  "id",
  "featureId",
  "featureSlug",
  "taskId",
  "success",
  "result",
  "nextCommand"
);
const assuranceCaseSchema = requiredRecord(
  "version",
  "featureId",
  "featureSlug",
  "taskId",
  "caseHash"
);

const reviewDecisionPointerSchema = z
  .object({
    version: z.literal("1.0"),
    featureId: NON_EMPTY_STRING,
    featureSlug: NON_EMPTY_STRING,
    taskId: NON_EMPTY_STRING,
    decisionPath: NON_EMPTY_STRING,
    decisionHash: SHA256,
    updatedAt: ISO_DATE_TIME
  })
  .passthrough();

const reviewDecisionSchema = z
  .object({
    version: z.literal("1.0"),
    featureId: NON_EMPTY_STRING,
    featureSlug: NON_EMPTY_STRING,
    taskId: NON_EMPTY_STRING,
    reviewerId: NON_EMPTY_STRING,
    identityAssurance: NON_EMPTY_STRING,
    decision: NON_EMPTY_STRING,
    reason: NON_EMPTY_STRING,
    decidedAt: ISO_DATE_TIME,
    decisionHash: SHA256
  })
  .passthrough()
  .superRefine((decision, context) => {
    const { decisionHash, signature: _signature, ...withoutHash } = decision;
    if (decisionHash !== createTestReviewDecisionHash(withoutHash)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decisionHash"],
        message: "Decision hash does not match canonical test-fixture content."
      });
    }
  });

const runIndexEntrySchema = z
  .object({
    id: NON_EMPTY_STRING,
    command: NON_EMPTY_STRING,
    startedAt: ISO_DATE_TIME,
    endedAt: ISO_DATE_TIME,
    success: z.boolean(),
    result: z.enum(["passed", "warnings", "failed"]),
    runPath: NON_EMPTY_STRING
  })
  .passthrough();

const runIndexSchema = z
  .object({
    latestRunId: NON_EMPTY_STRING.nullable(),
    runs: z.array(runIndexEntrySchema)
  })
  .passthrough();

const runEventSchema = z
  .object({
    id: NON_EMPTY_STRING,
    runId: NON_EMPTY_STRING,
    type: z.enum([
      "command_started",
      "command_completed",
      "command_failed",
      "gate_evaluated",
      "artifact_written",
      "budget_estimated",
      "usage_recorded",
      "evidence_recorded",
      "override_applied"
    ]),
    command: NON_EMPTY_STRING,
    featureId: NON_EMPTY_STRING.optional(),
    featureSlug: NON_EMPTY_STRING.optional(),
    taskId: NON_EMPTY_STRING.optional(),
    message: NON_EMPTY_STRING,
    artifactPath: NON_EMPTY_STRING.optional(),
    ruleId: NON_EMPTY_STRING.optional(),
    overrideId: NON_EMPTY_STRING.optional(),
    data: z.record(z.unknown()).optional(),
    createdAt: ISO_DATE_TIME
  })
  .strict();

export const testArtifactSchemas = Object.freeze({ runEvent: runEventSchema });

export function createTestReviewDecisionHash(decision: unknown): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(REVIEW_DECISION_HASH_DOMAIN, "utf8")
    .update(canonicalJson(decision), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function createTestArtifactReader(rootPath: string): CockpitKitArtifactReader {
  return Object.freeze({
    projectProfile: (options) =>
      readJson(rootPath, ".visp/project.json", projectProfileSchema, options),
    projectConfig: (options) =>
      readJson(rootPath, ".visp/config.json", projectConfigSchema, options),
    projectStatus: (options) =>
      readJson(rootPath, ".visp/status.json", projectStatusSchema, options),
    policy: (options) => readJson(rootPath, ".visp/policy.json", policySchema, options),
    workflowManifest: (options) => readJson(rootPath, ".visp/workflow.json", workflowSchema, options),
    featureIntent: (featureKey, options) =>
      readJson(rootPath, featurePath(featureKey, "intent.json"), featureIntentSchema, options),
    specification: (featureKey, options) =>
      readJson(rootPath, featurePath(featureKey, "spec.json"), specificationSchema, options),
    plan: (featureKey, options) =>
      readJson(rootPath, featurePath(featureKey, "plan.json"), planSchema, options),
    taskGraph: (featureKey, options) =>
      readJson(rootPath, featurePath(featureKey, "task-graph.json"), taskGraphSchema, options),
    verification: (featureKey, options) =>
      readJson(rootPath, featurePath(featureKey, "verification.json"), verificationSchema, options),
    taskReview: (featureKey, taskId, options) =>
      readJson(
        rootPath,
        featurePath(featureKey, `review/${safeSegment("Task ID", taskId)}.review.json`),
        taskReviewSchema,
        options
      ),
    assuranceCase: (featureKey, taskId, options) =>
      readJson(
        rootPath,
        assurancePath(featureKey, taskId, "assurance-case.json"),
        assuranceCaseSchema,
        options
      ),
    currentReviewDecision: (featureKey, taskId, options) =>
      readJson(
        rootPath,
        assurancePath(featureKey, taskId, "review-decision.json"),
        reviewDecisionPointerSchema,
        options
      ),
    reviewDecision: (featureKey, taskId, decisionHash, options) => {
      const digest = /^sha256:([a-f0-9]{64})$/u.exec(decisionHash)?.[1];
      if (digest === undefined) throw new TypeError("Decision hash is malformed.");
      return readJson(
        rootPath,
        assurancePath(featureKey, taskId, `review-decisions/${digest}.json`),
        reviewDecisionSchema,
        options
      );
    },
    runIndex: (options) => readJson(rootPath, ".visp/runs/index.json", runIndexSchema, options),
    constitution: (options) => readText(rootPath, ".visp/memory/constitution.md", options),
    patterns: (options) => readText(rootPath, ".visp/memory/patterns.md", options),
    projectSummary: (options) => readText(rootPath, ".visp/memory/project-summary.md", options),
    doctorReport: (options) => readText(rootPath, ".visp/reports/doctor-report.md", options)
  });
}

function requiredRecord(...keys: readonly string[]): z.ZodType<Record<string, unknown>> {
  return z.record(z.unknown()).superRefine((value, context) => {
    for (const key of keys) {
      if (!Object.hasOwn(value, key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Required fixture field is missing: ${key}.`
        });
      }
    }
  });
}

function featurePath(featureKey: string, leaf: string): string {
  return `.visp/features/${safeSegment("Feature key", featureKey)}/${leaf}`;
}

function assurancePath(featureKey: string, taskId: string, leaf: string): string {
  return [
    ".visp/features",
    safeSegment("Feature key", featureKey),
    "assurance",
    safeSegment("Task ID", taskId),
    leaf
  ].join("/");
}

function safeSegment(label: string, value: string): string {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} must be one safe path segment.`);
  }
  return value;
}

async function readJson(
  rootPath: string,
  sourcePath: string,
  schema: z.ZodType,
  options?: CockpitKitReadOptions
): Promise<CockpitKitReadState> {
  const artifactPath = resolve(rootPath, sourcePath);
  const file = await readFileState(rootPath, sourcePath);
  if (!file.ok) return file.state;

  let candidate: unknown;
  try {
    candidate = JSON.parse(file.text);
  } catch {
    return unreadable(artifactPath, "invalid_json", `Invalid JSON in ${artifactPath}.`);
  }

  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return unreadable(artifactPath, "invalid_schema", `Invalid schema in ${artifactPath}.`);
  }
  return withFreshness(artifactPath, parsed.data, file.modifiedAt, options);
}

async function readText(
  rootPath: string,
  sourcePath: string,
  options?: CockpitKitReadOptions
): Promise<CockpitKitReadState> {
  const artifactPath = resolve(rootPath, sourcePath);
  const file = await readFileState(rootPath, sourcePath);
  if (!file.ok) return file.state;
  if (file.text.trim().length === 0) {
    return unreadable(
      artifactPath,
      "invalid_schema",
      `Text artifact is empty at ${artifactPath}.`
    );
  }
  return withFreshness(artifactPath, file.text, file.modifiedAt, options);
}

async function readFileState(
  rootPath: string,
  sourcePath: string
): Promise<
  | Readonly<{ ok: true; text: string; modifiedAt: string }>
  | Readonly<{ ok: false; state: CockpitKitReadState }>
> {
  const artifactPath = resolve(rootPath, sourcePath);
  let handle: FileHandle | undefined;
  try {
    const resolved = await resolveContainedExistingPath(rootPath, sourcePath, "file");
    handle = await open(resolved.absolutePath, READ_FLAGS);
    const info = await handle.stat();
    if (!info.isFile()) throw new TypeError("Artifact path must name a regular file.");
    const bytes = await handle.readFile();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return Object.freeze({ ok: true, text, modifiedAt: info.mtime.toISOString() });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return Object.freeze({
        ok: false,
        state: Object.freeze({
          state: "missing" as const,
          path: artifactPath,
          reason: `Artifact is missing at ${artifactPath}.`
        })
      });
    }
    return Object.freeze({
      ok: false,
      state: unreadable(
        artifactPath,
        "io",
        `Unable to read ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`
      )
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function withFreshness(
  sourcePath: string,
  value: unknown,
  modifiedAt: string,
  options?: CockpitKitReadOptions
): CockpitKitReadState {
  if (options?.staleAfter !== undefined && Date.parse(modifiedAt) < options.staleAfter.getTime()) {
    return Object.freeze({
      state: "stale" as const,
      path: sourcePath,
      modifiedAt,
      staleAfter: options.staleAfter.toISOString(),
      reason: `Artifact at ${sourcePath} is older than the required freshness boundary.`,
      value
    });
  }
  return Object.freeze({ state: "present" as const, path: sourcePath, modifiedAt, value });
}

function unreadable(
  sourcePath: string,
  issue: "io" | "invalid_json" | "invalid_schema",
  reason: string
): CockpitKitReadState {
  return Object.freeze({ state: "unreadable" as const, path: sourcePath, issue, reason });
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && "code" in error && error.code === code;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical test JSON requires finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Canonical test JSON does not support ${typeof value}.`);
}
