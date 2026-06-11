import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import { readTextIfExists } from "../../core/fs-utils.js";
import { getActiveSession, readConfig, updateActiveSession } from "../../core/session-manager.js";
import type { MemoryRecord, SessionRecord } from "../../core/types.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { writeSessionMemory } from "../../memory/file-memory-provider.js";
import { LlmMemoryProvider } from "../../memory/llm-memory-provider.js";
import { selectMemoryProvider } from "../../memory/provider-factory.js";
import { appendUsage } from "../../telemetry/telemetry-store.js";
import { resolveProjectPath } from "./shared.js";

const execFileAsync = promisify(execFile);

export function rememberCommand(): Command {
  return new Command("remember")
    .description("Write a local memory summary for the active session.")
    .option("--summary <summary>", "Session summary to store.", "Session completed. Review generated artifacts for details.")
    .option("--decision <decision...>", "Decision to include in memory.")
    .option("--follow-up <followUp...>", "Follow-up to include in memory.")
    .option("--input-tokens <n>", "Input token count for this session, recorded to telemetry and forwarded to the kit budget.")
    .option("--output-tokens <n>", "Output token count for this session, recorded to telemetry and forwarded to the kit budget.")
    .option("--model <name>", "Model name associated with the recorded token usage.")
    .action(async function (
      this: Command,
      options: {
        summary: string;
        decision?: string[];
        followUp?: string[];
        inputTokens?: string;
        outputTokens?: string;
        model?: string;
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
      const path = await writeSessionMemory({ projectPath, ...record });
      await writeBackRemoteMemory(projectPath, record);
      await recordTokenUsage(projectPath, session, options);
      await updateActiveSession(projectPath, (current) => ({ ...current, phase: "remembered" }));
      console.log(`Memory written to ${path}`);
    });
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
async function writeBackRemoteMemory(projectPath: string, record: MemoryRecord): Promise<void> {
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
    for (const warning of selection.provider.warnings) {
      console.warn(warning);
    }
  }
}

async function changedFiles(projectPath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only"], { cwd: projectPath });
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeReview(report: string): string {
  return report.split("\n").slice(0, 20).join("\n").trim();
}
