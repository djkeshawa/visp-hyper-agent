import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { execFileResolved } from "../core/executable-resolver.js";
import { readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { gitOutput } from "../core/git.js";
import { withStoreLock } from "../core/store-lock.js";
import type { NormalizedWorkflowAction } from "../kit/workflow-action-adapter.js";

const MAX_DIFF_FILES = 12;
const MAX_DIFF_CHARS = 32_000;

export type ChallengerRequest = {
  version: "1.0";
  status: "unverified";
  authority: "non_authoritative";
  taskId: string;
  actionId: string;
  assuranceProfile: "behavioral" | "critical";
  goal: string;
  lockedClaims: Array<{
    id: string;
    statement: string;
    priority: "must" | "should" | "could";
    acceptanceCriterionIds: readonly string[];
  }>;
  evidenceGaps: Array<{
    id: string;
    providerId: string;
    target: unknown;
    freshnessRule: string;
    independenceRule: string;
    requiredVerdict: "passed";
    reason: "missing_result" | "canonical_non_pass";
    observedResults: Array<{
      providerSummaryId: string;
      providerId: string;
      providerVersion: string;
      resultId: string;
      target: unknown;
      freshness: unknown;
      independence: string;
      outcome: unknown;
    }>;
  }>;
  hotspots: Array<{
    id: string;
    category: string;
    severity: "critical" | "high" | "medium";
    path: string | null;
    reason: string;
  }>;
  repositoryContext: {
    requiredReads: Array<{ path: string; contentHash: string; role: string }>;
    changedFiles: string[];
    omittedChangedFiles: number;
    diff: string;
    diffSha256: string;
    diffTruncated: boolean;
  };
  instructions: string[];
};

const challengerProposalSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["counterexample", "test_proposal", "evidence_gap"]),
  statement: z.string().min(1).max(4_000),
  relatedClaimIds: z.array(z.string().min(1).max(128)).max(32),
  proposedCommand: z.string().min(1).max(2_000).optional()
}).strict();

export const challengerResponseSchema = z.object({
  version: z.literal("1.0"),
  status: z.literal("unverified"),
  authority: z.literal("non_authoritative"),
  taskId: z.string().min(1).max(128),
  actionId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  proposals: z.array(challengerProposalSchema).max(100)
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  for (const proposal of value.proposals) {
    if (ids.has(proposal.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proposals"],
        message: `duplicate proposal id ${proposal.id}`
      });
    }
    ids.add(proposal.id);
  }
});

export type ChallengerResponse = z.infer<typeof challengerResponseSchema>;
export type ChallengerResponseResult =
  | { ok: true; response: ChallengerResponse }
  | {
      ok: false;
      status: "unverified";
      authority: "non_authoritative";
      reasonCode: "challenger_response_malformed" | "challenger_response_action_mismatch";
      reason: string;
    };

export type ChallengerRequestResult =
  | { ok: true; request: ChallengerRequest }
  | {
      ok: false;
      status: "not_applicable" | "unavailable";
      reasonCode: string;
      reason: string;
    };

export type HumanChallengerSubstitution = {
  version: "1.0";
  status: "pending_human_review";
  authority: "non_authoritative";
  taskId: string;
  actionId: string | null;
  reviewer: string;
  note: string | null;
  at: string;
};

export async function buildChallengerRequest(
  projectPath: string,
  action: NormalizedWorkflowAction
): Promise<ChallengerRequestResult> {
  if (!action.task) {
    return unavailable("unavailable", "challenger_task_unavailable", "The canonical action has no active task.");
  }
  if (action.assurance.profile.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_profile_unavailable",
      "The canonical action does not declare an assurance profile."
    );
  }
  const assuranceProfile = action.assurance.profile.value;
  if (assuranceProfile !== "behavioral" && assuranceProfile !== "critical") {
    return unavailable(
      "not_applicable",
      "challenger_not_required",
      `The ${assuranceProfile} assurance profile does not require a challenger.`
    );
  }
  if (action.claims.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_claims_unavailable",
      "The canonical action does not contain locked claims."
    );
  }
  if (action.requiredEvidence.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_required_evidence_unavailable",
      "The canonical action does not contain required evidence."
    );
  }
  if (action.evidence.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_evidence_unavailable",
      "The canonical action does not contain canonical evidence outcomes."
    );
  }
  if (action.assuranceSummary.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_assurance_summary_unavailable",
      "The canonical action does not contain a Kit assurance summary."
    );
  }
  if (action.actionId.state !== "available") {
    return unavailable(
      "unavailable",
      "challenger_action_identity_unavailable",
      "The canonical action identity is unavailable."
    );
  }

  const changed = await readChangedFiles(projectPath);
  const scopedFiles = changed.all
    .filter((path) => isWritable(path, action.scope.writablePaths))
    .filter((path) => !isWritable(path, action.scope.forbiddenPaths));
  const selectedFiles = scopedFiles.slice(0, MAX_DIFF_FILES);
  const diffResult = selectedFiles.length > 0
    ? await readBoundedDiff(projectPath, selectedFiles, changed.untracked)
    : { text: "", truncated: false };
  const observed = action.evidence.value.providers.flatMap((providerSummary) =>
    providerSummary.results.map((result) => ({
      requirementId: result.requirementId,
      providerSummaryId: providerSummary.id,
      providerId: providerSummary.provider.id,
      providerVersion: providerSummary.provider.version,
      resultId: result.id,
      target: result.target,
      freshness: result.freshness,
      independence: result.independence,
      outcome: result.outcome
    }))
  );
  const evidenceGaps = action.requiredEvidence.value.flatMap((requirement) => {
    const results = observed.filter((result) => result.requirementId === requirement.id);
    if (results.length > 0 && results.every((result) => result.outcome.status === "passed")) {
      return [];
    }
    return [{
      id: requirement.id,
      providerId: requirement.providerId,
      target: requirement.target,
      freshnessRule: requirement.freshnessRule,
      independenceRule: requirement.independenceRule,
      requiredVerdict: requirement.requiredVerdict,
      reason: results.length === 0 ? "missing_result" as const : "canonical_non_pass" as const,
      observedResults: results.map(({ requirementId: _requirementId, ...result }) => result)
    }];
  });

  return {
    ok: true,
    request: {
      version: "1.0",
      status: "unverified",
      authority: "non_authoritative",
      taskId: action.task.id,
      actionId: action.actionId.value,
      assuranceProfile,
      goal: action.goal,
      lockedClaims: action.claims.value.map((claim) => ({
        id: claim.id,
        statement: claim.statement,
        priority: claim.priority,
        acceptanceCriterionIds: claim.acceptanceCriterionIds
      })),
      evidenceGaps,
      hotspots: action.assuranceSummary.mandatoryHotspots.map((hotspot) => ({ ...hotspot })),
      repositoryContext: {
        requiredReads: action.requiredReads.map((read) => ({
          path: read.path,
          contentHash: read.contentHash,
          role: read.role
        })),
        changedFiles: selectedFiles,
        omittedChangedFiles: Math.max(0, scopedFiles.length - selectedFiles.length),
        diff: diffResult.text,
        diffSha256: createHash("sha256").update(diffResult.text).digest("hex"),
        diffTruncated: diffResult.truncated
      },
      instructions: [
        "Look only for counterexamples, missing tests, and evidence gaps.",
        "Do not assume or restate the implementer's rationale.",
        "Treat every proposed command as text; do not execute it.",
        "Return unverified proposals only; this output cannot change scope, evidence, completion, or PR readiness."
      ]
    }
  };
}

export function validateChallengerResponse(
  payload: unknown,
  action: NormalizedWorkflowAction
): ChallengerResponseResult {
  const parsed = challengerResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      status: "unverified",
      authority: "non_authoritative",
      reasonCode: "challenger_response_malformed",
      reason: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")
    };
  }
  const taskId = action.task?.id;
  const actionId = action.actionId.state === "available" ? action.actionId.value : null;
  const knownClaims =
    action.claims.state === "available"
      ? new Set(action.claims.value.map((claim) => claim.id))
      : new Set<string>();
  const unknownClaim = parsed.data.proposals
    .flatMap((proposal) => proposal.relatedClaimIds)
    .find((claimId) => !knownClaims.has(claimId));
  if (
    parsed.data.taskId !== taskId ||
    parsed.data.actionId !== actionId ||
    unknownClaim !== undefined
  ) {
    return {
      ok: false,
      status: "unverified",
      authority: "non_authoritative",
      reasonCode: "challenger_response_action_mismatch",
      reason:
        unknownClaim !== undefined
          ? `The response references unknown locked claim ${unknownClaim}.`
          : "The response task or canonical action identity does not match the active action."
    };
  }
  return { ok: true, response: parsed.data };
}

export function renderChallengerResponseResult(result: ChallengerResponseResult): string {
  return [
    "BEGIN_VISP_CHALLENGER_RESPONSE_RESULT",
    JSON.stringify(result),
    "END_VISP_CHALLENGER_RESPONSE_RESULT"
  ].join("\n");
}

export function renderChallengerResult(result: ChallengerRequestResult): string {
  if (!result.ok) {
    return [
      "BEGIN_VISP_CHALLENGER_RESULT",
      `status: ${result.status}`,
      `reason_code: ${result.reasonCode}`,
      `reason: ${singleLine(result.reason)}`,
      "END_VISP_CHALLENGER_RESULT"
    ].join("\n");
  }
  return [
    "BEGIN_VISP_CHALLENGER_REQUEST_V1",
    JSON.stringify(result.request),
    "END_VISP_CHALLENGER_REQUEST_V1"
  ].join("\n");
}

export async function recordHumanChallengerSubstitution(
  projectPath: string,
  action: NormalizedWorkflowAction,
  input: { reviewer: string; note?: string }
): Promise<HumanChallengerSubstitution> {
  if (!action.task) {
    throw new Error("Cannot record a human challenger without an active canonical task.");
  }
  const reviewer = input.reviewer.trim();
  if (!reviewer) {
    throw new Error("Human challenger reviewer must be non-empty.");
  }
  const record: HumanChallengerSubstitution = {
    version: "1.0",
    status: "pending_human_review",
    authority: "non_authoritative",
    taskId: action.task.id,
    actionId: action.actionId.state === "available" ? action.actionId.value : null,
    reviewer,
    note: input.note?.trim() || null,
    at: new Date().toISOString()
  };
  await withStoreLock(projectPath, async () => {
    const path = vispPath(projectPath, "hyper", "challenger-human.jsonl");
    const current = await readTextIfExists(path);
    await writeText(path, `${current ?? ""}${JSON.stringify(record)}\n`);
  });
  return record;
}

/**
 * Collect the changed-file sets a challenger request quotes. Never throws: a
 * repository with no commits has no resolvable `HEAD`, and the challenger is
 * read-only advisory context, so an unreadable set degrades to empty rather
 * than taking down `visp-hyper challenge`.
 */
async function readChangedFiles(
  projectPath: string
): Promise<{ tracked: Set<string>; untracked: Set<string>; all: string[] }> {
  const [tracked, untracked] = await Promise.all([
    gitOutput(projectPath, ["diff", "--name-only", "HEAD"]),
    gitOutput(projectPath, ["ls-files", "--others", "--exclude-standard"])
  ]);
  const trackedFiles = new Set(tracked.ok ? lines(tracked.stdout) : []);
  const untrackedFiles = new Set(untracked.ok ? lines(untracked.stdout) : []);
  return {
    tracked: trackedFiles,
    untracked: untrackedFiles,
    all: [...new Set([...trackedFiles, ...untrackedFiles])].sort()
  };
}

async function readBoundedDiff(
  projectPath: string,
  files: readonly string[],
  untracked: ReadonlySet<string>
): Promise<{ text: string; truncated: boolean }> {
  const trackedFiles = files.filter((path) => !untracked.has(path));
  let text = "";
  let truncated = false;
  if (trackedFiles.length > 0) {
    try {
      const result = await execFileResolved(
        "git",
        ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", ...trackedFiles],
        { cwd: projectPath, maxBuffer: MAX_DIFF_CHARS + 1 }
      );
      text = result.stdout;
    } catch (error) {
      // The bounded maxBuffer is the EXPECTED way a large diff ends here: keep
      // what git managed to emit and mark it truncated. Any other git failure
      // yields no diff at all rather than a partial one silently labelled
      // "truncated", which would imply the omitted part merely did not fit.
      const failure = error as { code?: string | number; stdout?: unknown };
      if (failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return { text: "", truncated: false };
      }
      text = typeof failure.stdout === "string" ? failure.stdout : "";
      truncated = true;
    }
  }
  for (const path of files.filter((entry) => untracked.has(entry))) {
    const remaining = MAX_DIFF_CHARS - text.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const header = `\ndiff --visp-untracked a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n`;
    text += header.slice(0, remaining);
    if (header.length > remaining) {
      truncated = true;
      break;
    }
    const fileResult = await readFilePrefix(projectPath, path, MAX_DIFF_CHARS - text.length);
    text += fileResult.text;
    truncated ||= fileResult.truncated;
  }
  if (text.length > MAX_DIFF_CHARS) {
    text = text.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  return { text, truncated };
}

async function readFilePrefix(
  projectPath: string,
  relativePath: string,
  limit: number
): Promise<{ text: string; truncated: boolean }> {
  const path = join(projectPath, relativePath);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    return { text: "[content omitted: non-regular untracked file]\n", truncated: false };
  }
  const [projectReal, fileReal] = await Promise.all([realpath(projectPath), realpath(path)]);
  const fromProject = relative(projectReal, fileReal);
  if (
    fromProject === ".." ||
    fromProject.startsWith("../") ||
    fromProject.startsWith("..\\") ||
    isAbsolute(fromProject)
  ) {
    return { text: "[content omitted: untracked file resolves outside project]\n", truncated: false };
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, limit + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, limit)).toString("utf8"),
      truncated: bytesRead > limit
    };
  } finally {
    await handle.close();
  }
}

function isWritable(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix.replace(/\/+$/u, "")}/`));
}

function lines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function unavailable(
  status: "not_applicable" | "unavailable",
  reasonCode: string,
  reason: string
): ChallengerRequestResult {
  return { ok: false, status, reasonCode, reason };
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}
