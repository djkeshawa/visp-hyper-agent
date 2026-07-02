import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Command } from "commander";
import { execFileCrossPlatform } from "../../core/exec.js";
import { readTextIfExists } from "../../core/fs-utils.js";
import { getActiveSession, readConfig, readState, updateActiveSession } from "../../core/session-manager.js";
import type { HyperConfig, MemoryRecord, SessionRecord } from "../../core/types.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { writeSessionMemory } from "../../memory/file-memory-provider.js";
import { LlmMemoryProvider } from "../../memory/llm-memory-provider.js";
import { selectMemoryProvider } from "../../memory/provider-factory.js";
import {
  moveToRejected,
  moveToStaged,
  scanIncoming,
  type SkillProposal
} from "../../skills/skill-proposals.js";
import { installSkill, isDuplicate, readSkillRegistry, recordUsage } from "../../skills/skill-registry.js";
import { appendUsage } from "../../telemetry/telemetry-store.js";
import { resolveProjectPath } from "./shared.js";

export function rememberCommand(): Command {
  return new Command("remember")
    .description("Write a local memory summary for the active session.")
    .option("--summary <summary>", "Session summary to store.", "Session completed. Review generated artifacts for details.")
    .option("--decision <decision...>", "Decision to include in memory.")
    .option("--follow-up <followUp...>", "Follow-up to include in memory.")
    .option("--input-tokens <n>", "Input token count for this session, recorded to telemetry and forwarded to the kit budget.")
    .option("--output-tokens <n>", "Output token count for this session, recorded to telemetry and forwarded to the kit budget.")
    .option("--model <name>", "Model name associated with the recorded token usage.")
    .option("--used-skill <name...>", "Record usage of an installed skill by name (repeatable).")
    .action(async function (
      this: Command,
      options: {
        summary: string;
        decision?: string[];
        followUp?: string[];
        inputTokens?: string;
        outputTokens?: string;
        model?: string;
        usedSkill?: string[];
      }
    ) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        throw new Error("No active Visp Hyper session. Run `visp-hyper start` first.");
      }
      const reviewSummary = await readTextIfExists(join(projectPath, ".visp", "hyper", "current", "review-report.md"));
      const record = {
        sessionId: session.id,
        goal: session.goal,
        summary: options.summary,
        changedFiles: await changedFiles(projectPath),
        reviewSummary: reviewSummary ? summarizeReview(reviewSummary) : undefined,
        decisions: options.decision,
        followUps: options.followUp
      };
      // The local memory write is best-effort: a permission/disk failure must
      // degrade to a warning, not crash the command (DEGRADE NEVER CRASH). The
      // downstream steps and the remote mirror remain useful even if it fails.
      let path: string | null = null;
      try {
        path = await writeSessionMemory({ projectPath, ...record });
      } catch (error) {
        console.warn(
          `warning: local session memory could not be written: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      const config = await readConfig(projectPath);
      const harvest = await harvestSkillProposals(projectPath, config, session);
      for (const line of harvest.lines) {
        console.log(line);
      }
      await writeBackRemoteMemory(projectPath, record, harvest.installed);
      await recordSkillUsage(projectPath, options.usedSkill);
      await recordTokenUsage(projectPath, session, options);
      await updateActiveSession(projectPath, (current) => ({ ...current, phase: "remembered" }));
      if (path) {
        console.log(`Memory written to ${path}`);
      } else {
        console.log("Memory not persisted locally (see warning above); session marked remembered.");
      }
    });
}

/**
 * Process agent-dropped skill proposals: reject invalid files, skip duplicates,
 * and either stage (review mode) or install (auto mode) new proposals. Returns
 * the report lines to print plus the proposals that were actually installed this
 * run (for memory mirroring). All failures degrade to a warning line so the host
 * command never breaks.
 */
export async function harvestSkillProposals(
  projectPath: string,
  config: HyperConfig,
  session: SessionRecord
): Promise<{ lines: string[]; installed: SkillProposal[] }> {
  const lines: string[] = [];
  const installed: SkillProposal[] = [];
  try {
    const { valid, invalid } = await scanIncoming(projectPath);

    for (const entry of invalid) {
      await moveToRejected(projectPath, entry.sourcePath, entry.error);
      lines.push(`skill rejected: ${basename(entry.sourcePath)} (${entry.error})`);
    }

    if (valid.length === 0) {
      return { lines, installed };
    }

    const { registry } = await readSkillRegistry(projectPath);
    const state = await readState(projectPath);
    const sessionCount = Object.keys(state.sessions).length;

    for (const proposal of valid) {
      if (isDuplicate(registry, proposal)) {
        await rm(proposal.sourcePath, { force: true });
        lines.push(`skill skipped (duplicate): ${proposal.name}`);
        continue;
      }

      if (config.skillMode === "review") {
        await moveToStaged(projectPath, proposal.sourcePath);
        lines.push(`skill staged for review: ${proposal.name}`);
        continue;
      }

      const result = await installSkill(projectPath, proposal, {
        tool: session.tool,
        sessionId: session.id,
        sessionCount
      });
      if (result.installed) {
        await rm(proposal.sourcePath, { force: true });
        // installSkill already persisted this entry to disk (it re-reads the
        // registry fresh, appends, and writes). This push only keeps the
        // in-memory `registry` current so isDuplicate() sees skills installed
        // earlier in THIS same batch; it is intentionally not written back.
        registry.skills.push({
          name: proposal.name,
          description: proposal.description,
          whenToUse: proposal.whenToUse,
          originSessionId: session.id,
          installedAtSessionCount: sessionCount,
          destinations: [result.destination],
          usedCount: 0,
          lastUsedAt: null,
          lastUsedSessionCount: null
        });
        installed.push(proposal);
        lines.push(`skill installed: ${proposal.name} -> ${result.destination}`);
      } else if (result.warning) {
        lines.push(`warning: ${result.warning}`);
      }
    }
  } catch (error) {
    lines.push(`warning: skill harvesting failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { lines, installed };
}

/**
 * Record usages for skills named via `--used-skill`. Unknown names degrade to a
 * warning line; the command still exits zero.
 */
async function recordSkillUsage(projectPath: string, names: string[] | undefined): Promise<void> {
  if (!names || names.length === 0) {
    return;
  }
  const state = await readState(projectPath);
  const sessionCount = Object.keys(state.sessions).length;
  for (const name of names) {
    try {
      const recorded = await recordUsage(projectPath, name, { sessionCount });
      if (!recorded) {
        console.log(`warning: unknown skill: ${name}`);
      }
    } catch (error) {
      console.log(`warning: skill usage was not recorded for ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Parse a CLI-supplied integer. Returns the parsed non-negative integer, or
 * `undefined` (with a warning) for anything that is not a clean integer.
 */
function parseTokenCount(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(`warning: --${label} "${raw}" is not a valid integer; ignoring.`);
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

/**
 * Record per-session token usage to the local telemetry store and, when the
 * external kit is available, forward the usage to its budget ledger. All
 * failures degrade to warnings; the command always exits zero.
 */
async function recordTokenUsage(
  projectPath: string,
  session: SessionRecord,
  options: { inputTokens?: string; outputTokens?: string; model?: string }
): Promise<void> {
  const inputTokens = parseTokenCount(options.inputTokens, "input-tokens");
  const outputTokens = parseTokenCount(options.outputTokens, "output-tokens");
  const model = options.model;

  if (inputTokens === undefined && outputTokens === undefined && model === undefined) {
    return;
  }

  try {
    await appendUsage(projectPath, { sessionId: session.id, inputTokens, outputTokens, model });
  } catch (error) {
    console.warn(`warning: token usage was not recorded locally: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Only forward to the kit budget when actual token counts were provided.
  if (inputTokens === undefined && outputTokens === undefined) {
    return;
  }

  const budgetTaskId = session.pipeline?.currentTaskId ?? session.pipeline?.completed.at(-1);
  if (!budgetTaskId) {
    console.warn("warning: token usage recorded locally; no pipeline task is associated with this session for budget forwarding.");
    return;
  }

  let availability;
  try {
    availability = await detectVisp(projectPath);
  } catch {
    availability = null;
  }

  if (!availability || !availability.available) {
    console.warn("warning: token usage recorded locally; visp kit unavailable for budget forwarding.");
    return;
  }

  try {
    const bridge = new KitCommandBridge({ projectPath });
    await bridge.recordBudget({ taskId: budgetTaskId, inputTokens, outputTokens, model, note: "visp-hyper remember" });
    for (const warning of bridge.warnings) {
      console.warn(`warning: ${warning}`);
    }
  } catch (error) {
    console.warn(`warning: token usage recorded locally; budget forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Mirror the just-written session memory to the configured remote provider when
 * llm-memory mode is active and healthy. Remote failure or fallback is non-fatal:
 * the file write already succeeded, so we only surface warnings and exit zero.
 */
async function writeBackRemoteMemory(
  projectPath: string,
  record: MemoryRecord,
  installedSkills: SkillProposal[]
): Promise<void> {
  const config = await readConfig(projectPath);
  const selection = await selectMemoryProvider({ config, projectPath });
  for (const warning of selection.warnings) {
    console.warn(warning);
  }
  if (!selection.provider) {
    return;
  }
  await selection.provider.remember(record);
  if (selection.provider instanceof LlmMemoryProvider) {
    const provider = selection.provider;
    for (const decision of record.decisions ?? []) {
      await provider.storeDecision({ title: "Session decision", decision });
    }
    for (const followUp of record.followUps ?? []) {
      await provider.storeFollowUp(followUp);
    }
    for (const skill of installedSkills) {
      await provider.storePattern(
        `Skill available: hyper-${skill.name} — ${skill.description} (when: ${skill.whenToUse})`
      );
    }
    for (const warning of provider.warnings) {
      console.warn(warning);
    }
  }
}

async function changedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileCrossPlatform("git", ["diff", "--name-only"], { cwd: projectPath });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeReview(report: string): string {
  return report.split("\n").slice(0, 20).join("\n").trim();
}
