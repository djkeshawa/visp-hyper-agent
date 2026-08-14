// P10-US-05/07: `recall` and `learn`.
//
// Memory is optional by design (D-118): when visp-memory is absent or not
// configured these verbs refuse visibly — they never pretend an empty answer
// is a real one. When present, they speak the versioned Memory CLI contract
// (P10-US-07) rather than importing Memory internals: retrieval and lifecycle
// semantics stay in Memory, and a durable write is a quarantined proposal
// through the reviewed lifecycle, never a direct model write.

import { getActiveSession, readConfig } from "../../core/session-manager.js";
import {
  memoryContractRecall,
  memoryContractPropose,
  type MemoryRecallScope
} from "../../memory/memory-cli-contract.js";

/**
 * A4(a): a manual `visp recall` still happens inside a task, so tell Memory
 * which one.
 *
 * Without an active session there is nothing held and nothing is sent — the
 * query stands alone, exactly as before.
 */
async function activeSessionScope(projectPath: string): Promise<MemoryRecallScope> {
  const session = await getActiveSession(projectPath);
  if (session === null) return {};
  return {
    task: session.goal,
    files: session.relevantFiles,
    sessionId: session.id
  };
}

export async function runRecallVerb(projectPath: string, query: string): Promise<void> {
  const config = await readConfig(projectPath);
  if (config.memoryMode !== "llm-memory") {
    console.error(
      [
        "visp recall needs visp-memory, which is not configured for this project.",
        "Run `visp setup` — it installs what is missing and configures memory here.",
        "Nothing was retrieved."
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  if (query.trim().length === 0) {
    console.error("visp recall needs a query: visp recall <what you are looking for>");
    process.exitCode = 1;
    return;
  }
  const result = await memoryContractRecall({
    projectPath,
    endpoint: config.memoryEndpoint,
    repoId: config.memoryRepoId,
    query,
    scope: await activeSessionScope(projectPath)
  });
  if (!result.ok) {
    console.error(`visp recall: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (result.degraded !== undefined) {
    console.error(`warning: ${result.degraded}`);
  }
  if (result.entries.length === 0) {
    const intents = result.intentMatches ?? 0;
    console.log(
      intents > 0
        ? `No stored memory matched, but ${intents} goal-layer intent${intents === 1 ? "" : "s"} did — see visp-memory list-intents.`
        : "No relevant memory found. (Memory answered; there was nothing to say.)"
    );
    return;
  }
  for (const entry of result.entries) {
    console.log(`- [${entry.kind}] ${entry.content}${entry.caveat === undefined ? "" : ` (${entry.caveat})`}`);
  }
}

export async function runLearnVerb(projectPath: string, note: string): Promise<void> {
  const config = await readConfig(projectPath);
  if (config.memoryMode !== "llm-memory") {
    console.error(
      [
        "visp learn needs visp-memory, which is not configured for this project.",
        "Run `visp setup` — it installs what is missing and configures memory here.",
        "Nothing was recorded."
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  if (note.trim().length === 0) {
    console.error("visp learn needs content: visp learn <what should be remembered>");
    process.exitCode = 1;
    return;
  }
  const result = await memoryContractPropose({
    projectPath,
    endpoint: config.memoryEndpoint,
    repoId: config.memoryRepoId,
    content: note
  });
  if (!result.ok) {
    console.error(`visp learn: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Proposed for review (id ${result.proposalId}). It becomes durable only after Memory's reviewed lifecycle accepts it.`
  );
}
