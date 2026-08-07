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

export type MemoryRecallResult =
  | {
      readonly ok: true;
      readonly entries: readonly { kind: string; content: string; caveat?: string }[];
      readonly intentMatches?: number;
    }
  | { readonly ok: false; readonly reason: string };

export type MemoryProposeResult =
  | { readonly ok: true; readonly proposalId: string }
  | { readonly ok: false; readonly reason: string };

async function runContract(
  projectPath: string,
  args: readonly string[]
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFileResolved("visp-memory", [...args], {
      cwd: projectPath,
      timeout: CONTRACT_TIMEOUT_MS
    });
    return { ok: true, stdout };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code === "ENOENT" || failure.code === "EINVAL") {
      return {
        ok: false,
        reason:
          "visp-memory is not installed (the visp-memory command was not found). Install it with: pip install visp-memory"
      };
    }
    return {
      ok: false,
      reason: `visp-memory did not answer: ${failure.message ?? String(error)}`
    };
  }
}

function scopeArgs(input: { readonly endpoint?: string; readonly repoId?: string }): string[] {
  return [
    ...(input.repoId === undefined ? [] : ["--repo", input.repoId]),
    ...(input.endpoint === undefined ? [] : ["--endpoint", input.endpoint])
  ];
}

export async function memoryContractRecall(input: {
  readonly projectPath: string;
  readonly endpoint?: string;
  readonly repoId?: string;
  readonly query: string;
}): Promise<MemoryRecallResult> {
  const run = await runContract(input.projectPath, [
    "contract",
    "recall",
    input.query,
    ...scopeArgs(input),
    "--json"
  ]);
  if (!run.ok) return run;
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
  return { ok: true, entries: parsed.data.entries, intentMatches: parsed.data.intentMatches };
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
    ...scopeArgs(input),
    "--json"
  ]);
  if (!run.ok) return run;
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
