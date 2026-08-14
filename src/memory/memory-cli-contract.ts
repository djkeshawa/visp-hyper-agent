// P10-US-05/07: Hyper's side of the versioned Memory CLI contract.
//
// Hyper's dependency set is {commander, zod} and stays that way: instead of an
// MCP client, `recall` and `learn` spawn the `visp-memory` CLI's machine
// contract (`visp-memory contract …`, contract version 1.0, built in
// P10-US-07). Retrieval and lifecycle semantics stay in Memory; Hyper only
// validates the envelope. Every failure mode is a visible refusal — an absent
// or non-answering Memory never turns into a silent empty result.

import { z } from "zod";

import { execFileResolved } from "../core/executable-resolver.js";

export const MEMORY_CONTRACT_VERSION = "1.0";
const CONTRACT_TIMEOUT_MS = 20_000;

const recallEnvelopeSchema = z.object({
  contractVersion: z.literal(MEMORY_CONTRACT_VERSION),
  success: z.boolean(),
  entries: z
    .array(
      z.object({
        kind: z.string(),
        content: z.string(),
        caveat: z.string().optional()
      })
    )
    .default([]),
  // Additive in contract 1.0: how many goal-layer intents matched when the
  // recall itself was empty. Without it the coordinator said "there was
  // nothing to say" for the same query visp-memory answered with a signpost.
  intentMatches: z.number().int().nonnegative().optional(),
  reason: z.string().optional()
});

const proposeEnvelopeSchema = z.object({
  contractVersion: z.literal(MEMORY_CONTRACT_VERSION),
  success: z.boolean(),
  proposalId: z.string().optional(),
  reason: z.string().optional()
});

/**
 * A4(a): the context the coordinator already holds when it calls recall.
 *
 * `Memory.recall()` accepts all of this and uses it two ways. `task`, `files`,
 * `sessionId` and `constraints` feed `rank_with_context`, which adds
 * intent-awareness, file-proximity and constraint factors before ranking —
 * withholding them means recall guesses from the query text alone.
 * `environment` and `asOf` feed read eligibility, and withholding
 * `environment` is worse than neutral: a stored memory that declares an
 * environment is rejected outright when the caller declares none, so
 * environment-scoped knowledge was unreachable rather than merely unranked.
 *
 * Every field is optional because forwarding is only ever "pass on what you
 * actually have". Nothing here is synthesised to fill a slot.
 */
export type MemoryRecallScope = {
  /** The task in one sentence — usually the goal the session was started with. */
  readonly task?: string;
  /** Repository-relative paths the task is expected to touch. */
  readonly files?: readonly string[];
  /** What must not change: forbidden paths, acceptance criteria, stated limits. */
  readonly constraints?: readonly string[];
  readonly sessionId?: string;
  /** Environment scope tags a stored memory may be restricted to. */
  readonly environment?: readonly string[];
  /** ISO-8601 instant to evaluate temporal validity at. Omit to mean "now". */
  readonly asOf?: string;
};

export type MemoryRecallResult =
  | {
      readonly ok: true;
      readonly entries: readonly { kind: string; content: string; caveat?: string }[];
      readonly intentMatches?: number;
      /**
       * Set when the answer is real but was produced with less than what was
       * asked — today, only when the installed visp-memory is too old to accept
       * the scope flags. The recall succeeded; the ranking did not get the
       * context, and the caller must be able to say so.
       */
      readonly degraded?: string;
    }
  | { readonly ok: false; readonly reason: string };

export type MemoryProposeResult =
  | { readonly ok: true; readonly proposalId: string }
  | { readonly ok: false; readonly reason: string };

type ContractRun =
  | { ok: true; stdout: string }
  | { ok: false; reason: string; usageError: boolean };

async function runContract(projectPath: string, args: readonly string[]): Promise<ContractRun> {
  try {
    const { stdout } = await execFileResolved("visp-memory", [...args], {
      cwd: projectPath,
      timeout: CONTRACT_TIMEOUT_MS
    });
    return { ok: true, stdout };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (failure.code === "ENOENT" || failure.code === "EINVAL") {
      return {
        ok: false,
        usageError: false,
        reason:
          "visp-memory is not installed (the visp-memory command was not found). Install it with: pip install visp-memory"
      };
    }
    return {
      ok: false,
      usageError: isUsageError(failure),
      reason: `visp-memory did not answer: ${failure.message ?? String(error)}`
    };
  }
}

/**
 * Did visp-memory refuse the COMMAND LINE rather than the request?
 *
 * click (which Typer builds on) exits 2 for any usage error and names the
 * offending option. That is how an older visp-memory reports a scope flag it
 * has never heard of, and it is the one failure worth retrying — a retry of a
 * genuine recall failure would just spend a second subprocess to fail again.
 */
function isUsageError(failure: NodeJS.ErrnoException & { stdout?: string; stderr?: string }): boolean {
  // execFile reports a non-zero exit as a NUMBER in `code`, even though
  // ErrnoException types it as the string errno it carries for spawn failures.
  if ((failure.code as unknown) === 2) return true;
  const text = `${failure.stderr ?? ""}\n${failure.stdout ?? ""}\n${failure.message ?? ""}`;
  return /no such option|unrecognized arguments|unknown option|unexpected extra argument/iu.test(text);
}

function repoScopeArgs(input: { readonly endpoint?: string; readonly repoId?: string }): string[] {
  return [
    ...(input.repoId === undefined ? [] : ["--repo", input.repoId]),
    ...(input.endpoint === undefined ? [] : ["--endpoint", input.endpoint])
  ];
}

/**
 * Bounds on what crosses into an argument list.
 *
 * These are not tuning knobs. argv has an OS-imposed ceiling, and the file
 * list at a real call site is the whole selected context pack — passing all of
 * it would eventually produce E2BIG, which would present as "visp-memory did
 * not answer" and look like a Memory outage. Ranking gains nothing from the
 * two-hundredth path anyway; the first two dozen are the signal.
 */
const MAX_SCOPE_ITEMS = 24;
const MAX_ENVIRONMENT_ITEMS = 8;
const MAX_SCOPE_ITEM_CHARS = 256;
const MAX_TASK_CHARS = 512;

function flagIfPresent(flag: string, value: string | undefined, maxChars: number): string[] {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? [] : [flag, trimmed.slice(0, maxChars)];
}

function repeatedFlag(flag: string, values: readonly string[] | undefined, maxItems: number): string[] {
  if (values === undefined) return [];
  const kept: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const capped = trimmed.slice(0, MAX_SCOPE_ITEM_CHARS);
    if (kept.includes(capped)) continue;
    kept.push(capped);
    if (kept.length >= maxItems) break;
  }
  return kept.flatMap((value) => [flag, value]);
}

/**
 * Translate the held context into contract flags.
 *
 * One flag per repeated value (`--file a --file b`) rather than a packed
 * string, because a path or a constraint may legitimately contain a separator
 * and a packed encoding would silently split it in half.
 */
function recallScopeArgs(scope: MemoryRecallScope | undefined): string[] {
  if (scope === undefined) return [];
  return [
    ...flagIfPresent("--task", scope.task, MAX_TASK_CHARS),
    ...repeatedFlag("--file", scope.files, MAX_SCOPE_ITEMS),
    ...repeatedFlag("--constraint", scope.constraints, MAX_SCOPE_ITEMS),
    ...flagIfPresent("--session", scope.sessionId, MAX_SCOPE_ITEM_CHARS),
    ...repeatedFlag("--environment", scope.environment, MAX_ENVIRONMENT_ITEMS),
    ...flagIfPresent("--as-of", scope.asOf, MAX_SCOPE_ITEM_CHARS)
  ];
}

export async function memoryContractRecall(input: {
  readonly projectPath: string;
  readonly endpoint?: string;
  readonly repoId?: string;
  readonly query: string;
  /**
   * Relevance floor override. The pack the coordinator assembles is
   * explicitly untrusted, budget-capped context, so it may deliberately ask
   * for more recall than the human CLI's default precision floor.
   */
  readonly minScore?: number;
  /**
   * A4(a): what the caller already knows about the work being done. Forwarded
   * so recall can rank against the task instead of guessing from query text.
   */
  readonly scope?: MemoryRecallScope;
}): Promise<MemoryRecallResult> {
  const base = [
    "contract",
    "recall",
    input.query,
    ...(input.minScore === undefined ? [] : ["--min-score", String(input.minScore)]),
    ...repoScopeArgs(input)
  ];
  const scopeFlags = recallScopeArgs(input.scope);

  let degraded: string | undefined;
  let run = await runContract(input.projectPath, [...base, ...scopeFlags, "--json"]);
  if (!run.ok && run.usageError && scopeFlags.length > 0) {
    // The installed visp-memory predates the scope flags. Answering with the
    // query alone is exactly the old behaviour, so the recall still works —
    // but the loss is named rather than absorbed, because a quietly
    // context-free ranking is what this change exists to end.
    degraded =
      "visp-memory does not accept the recall scope flags, so task, file and constraint context was dropped; " +
      "ranking used the query text alone. Upgrade visp-memory to forward it.";
    run = await runContract(input.projectPath, [...base, "--json"]);
  }
  if (!run.ok) return { ok: false, reason: run.reason };

  const parsed = recallEnvelopeSchema.safeParse(safeJson(run.stdout));
  if (!parsed.success) {
    return {
      ok: false,
      reason: `visp-memory answered outside contract ${MEMORY_CONTRACT_VERSION}; upgrade visp-memory (needs >= 0.4.0).`
    };
  }
  if (!parsed.data.success) {
    return { ok: false, reason: parsed.data.reason ?? "Memory refused the recall." };
  }
  return {
    ok: true,
    entries: parsed.data.entries,
    intentMatches: parsed.data.intentMatches,
    ...(degraded === undefined ? {} : { degraded })
  };
}

export async function memoryContractPropose(input: {
  readonly projectPath: string;
  readonly endpoint?: string;
  readonly repoId?: string;
  readonly content: string;
}): Promise<MemoryProposeResult> {
  const run = await runContract(input.projectPath, [
    "contract",
    "propose",
    input.content,
    ...repoScopeArgs(input),
    "--json"
  ]);
  if (!run.ok) return { ok: false, reason: run.reason };
  const parsed = proposeEnvelopeSchema.safeParse(safeJson(run.stdout));
  if (!parsed.success) {
    return {
      ok: false,
      reason: `visp-memory answered outside contract ${MEMORY_CONTRACT_VERSION}; upgrade visp-memory (needs >= 0.4.0).`
    };
  }
  if (!parsed.data.success || parsed.data.proposalId === undefined) {
    return { ok: false, reason: parsed.data.reason ?? "Memory refused the proposal." };
  }
  return { ok: true, proposalId: parsed.data.proposalId };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
