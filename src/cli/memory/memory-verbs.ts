// P10-US-05/07: `recall` and `learn`.
//
// Memory is optional by design (D-118): when visp-memory is absent or not
// configured these verbs refuse visibly — they never pretend an empty answer
// is a real one. When present, they speak the versioned Memory CLI contract
// (P10-US-07) rather than importing Memory internals: retrieval and lifecycle
// semantics stay in Memory, and a durable write is a quarantined proposal
// through the reviewed lifecycle, never a direct model write.

import { readConfig } from "../../core/session-manager.js";
import { memoryContractRecall, memoryContractPropose } from "../../memory/memory-cli-contract.js";

export async function runRecallVerb(projectPath: string, query: string): Promise<void> {
  const config = await readConfig(projectPath);
  if (config.memoryMode !== "llm-memory") {
    console.error(
      [
        "visp recall needs visp-memory, which is not configured for this project.",
        'Set memoryMode to "llm-memory" in .visp/hyper/config.json (and install visp-memory) to enable it.',
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
    query
  });
  if (!result.ok) {
    console.error(`visp recall: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  if (result.entries.length === 0) {
    console.log("No relevant memory found. (Memory answered; there was nothing to say.)");
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
        'Set memoryMode to "llm-memory" in .visp/hyper/config.json (and install visp-memory) to enable it.',
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
