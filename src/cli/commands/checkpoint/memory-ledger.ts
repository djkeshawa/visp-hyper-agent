/**
 * The memory a completed task leaves behind: one capped completion line, plus
 * a line for each plan decision not yet recorded.
 *
 * The formatting functions are pure and separately exported so their shape
 * stays pinned by unit tests — memory that costs more to recall than it saves
 * is worse than no memory at all.
 */

import { join } from "node:path";
import { readTextIfExists, vispPath, writeText } from "../../../core/fs-utils.js";
import { getActiveSession, readConfig } from "../../../core/session-manager.js";
import { collectChangedFiles } from "../../../governance/scope-guard.js";
import { findMemoryGap } from "../../memory/memory-readiness.js";

/**
 * Format the compact completion memory for a verified task. Pure so the
 * shape — one line, capped, no artifact dumps — is pinned by a unit test:
 * memory that costs more tokens to recall than it saves is worse than none.
 */
export function taskCompletionMemory(input: {
  readonly taskId: string;
  readonly goal: string;
  readonly changedFiles: readonly string[];
}): string {
  const files = input.changedFiles.slice(0, 5).join(", ");
  const more = input.changedFiles.length > 5 ? ` (+${input.changedFiles.length - 5} more)` : "";
  const goal = input.goal.length > 160 ? `${input.goal.slice(0, 159)}…` : input.goal;
  return `Verified ${input.taskId}: ${goal}${files.length > 0 ? ` — files: ${files}${more}` : ""}`;
}

/**
 * Format one plan decision as a memory. Pure and capped for the same reason
 * as the completion line: decisions carry the domain vocabulary future goals
 * actually share ("overdue", "YYYY-MM-DD", file names) — the completion lines
 * alone described implementation minutiae and never matched the next
 * feature's goal in evaluation.
 */
export function decisionMemoryLine(input: {
  readonly featureKey: string;
  readonly id: string;
  readonly title: string;
  readonly decision: string;
}): string {
  const body = `${input.title} — ${input.decision}`;
  const capped = body.length > 220 ? `${body.slice(0, 219)}…` : body;
  return `Decision ${input.id} (${input.featureKey}): ${capped}`;
}

const memoryLedgerPath = (projectPath: string): string =>
  vispPath(projectPath, "hyper", "memory-ledger.json");

export async function recordCompletionMemory(projectPath: string, taskId: string): Promise<void> {
  try {
    const config = await readConfig(projectPath);
    if (config.memoryMode !== "llm-memory") return;
    const { execFileResolved } = await import("../../../core/executable-resolver.js");
    // Ask why Memory is unreachable, not merely whether a name resolves. The
    // guard here used to be `resolveExecutable`, which on POSIX returns the
    // bare name for anything at all: the check never fired, the spawn below
    // failed, and the catch reported `spawn visp-memory ENOENT` — accidentally
    // loud, and no help at all. Detecting the gap without saying so would have
    // been worse: a memory that was never recorded must never look like one
    // that was. So detect it properly and print the same diagnosis `recall`
    // and `learn` print, remedy included.
    const gap = await findMemoryGap(projectPath, config.memoryMode);
    if (gap) {
      console.log([`warning: memory was not recorded: ${gap.missing}`, gap.remedy].join("\n"));
      return;
    }
    const record = async (content: string, category: string, importance: string) =>
      execFileResolved(
        "visp-memory",
        ["record", content, "--category", category, "--importance", importance],
        { cwd: projectPath, timeout: 30_000 }
      );

    const session = await getActiveSession(projectPath);
    const diff = await collectChangedFiles(projectPath, { mode: "all" });
    await record(
      taskCompletionMemory({
        taskId,
        goal: session?.goal ?? "task goal unavailable",
        changedFiles: diff.files
      }),
      "task-completion",
      "0.6"
    );
    const remembered = ["task completion"];

    // The feature's accepted decisions, once each (a multi-task feature saves
    // several times; the ledger keeps re-saves from duplicating them).
    const decisions = await unrecordedPlanDecisions(projectPath);
    for (const decision of decisions) {
      await record(decision.line, "decision", "0.7");
    }
    if (decisions.length > 0) {
      remembered.push(`${decisions.length} plan decision(s)`);
      await markDecisionsRecorded(
        projectPath,
        decisions.map((decision) => decision.key)
      );
    }
    console.log(`remembered: ${remembered.join(", ")} recorded for future recall`);
  } catch (error) {
    console.log(
      `warning: memory was not recorded: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function unrecordedPlanDecisions(
  projectPath: string
): Promise<Array<{ key: string; line: string }>> {
  const statusText = await readTextIfExists(join(projectPath, ".visp", "status.json"));
  if (!statusText) return [];
  const status = JSON.parse(statusText) as { activeFeaturePath?: string };
  if (typeof status.activeFeaturePath !== "string") return [];
  const featureKey = status.activeFeaturePath.split("/").at(-1) ?? "feature";
  const planText = await readTextIfExists(
    join(projectPath, status.activeFeaturePath, "plan.json")
  );
  if (!planText) return [];
  const plan = JSON.parse(planText) as {
    decisions?: Array<{ id?: string; title?: string; decision?: string }>;
  };
  const ledgerText = await readTextIfExists(memoryLedgerPath(projectPath));
  const ledger = (ledgerText ? JSON.parse(ledgerText) : { decisions: [] }) as {
    decisions: string[];
  };
  const recorded = new Set(ledger.decisions ?? []);
  return (plan.decisions ?? [])
    .filter(
      (decision): decision is { id: string; title: string; decision: string } =>
        typeof decision.id === "string" &&
        typeof decision.title === "string" &&
        typeof decision.decision === "string"
    )
    .map((decision) => ({
      key: `${featureKey}:${decision.id}`,
      line: decisionMemoryLine({ featureKey, ...decision })
    }))
    .filter((decision) => !recorded.has(decision.key));
}

async function markDecisionsRecorded(projectPath: string, keys: readonly string[]): Promise<void> {
  const ledgerText = await readTextIfExists(memoryLedgerPath(projectPath));
  const ledger = (ledgerText ? JSON.parse(ledgerText) : { decisions: [] }) as {
    decisions: string[];
  };
  ledger.decisions = [...new Set([...(ledger.decisions ?? []), ...keys])];
  await writeText(memoryLedgerPath(projectPath), `${JSON.stringify(ledger, null, 2)}\n`);
}
