import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, Option } from "commander";
import { scanRelevantFiles } from "../../context/relevance-scanner.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { createSession, initializeProject, readConfig } from "../../core/session-manager.js";
import type { ContextFile, ContextPackOptions, HyperConfig, ToolProfile } from "../../core/types.js";
import { buildHandoffProtocol, renderHandoff } from "../../handoff/handoff-protocol.js";
import { isBlockedPath } from "../../governance/blocked-files.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import { readKitArtifacts } from "../../kit/kit-reader.js";
import type { KitContextPack } from "../../kit/kit-schemas.js";
import { readMemoryPack } from "../../memory/file-memory-provider.js";
import {
  renderAgentInstructions,
  renderContextPack,
  renderMemoryPack,
  renderQualityGates,
  renderSession
} from "../../output/markdown-writer.js";
import { resolveProjectPath } from "./shared.js";

export function startCommand(): Command {
  return new Command("start")
    .description("Start a guided coding session and print an Agent Handoff Protocol block.")
    .argument("<goal>", "Implementation goal.")
    .addOption(
      new Option("--tool <tool>", "Tool profile.")
        .choices(["generic", "codex", "claude-code", "copilot", "opencode"])
    )
    .action(async function (this: Command, goal: string, options: { tool?: ToolProfile }) {
      const projectPath = resolveProjectPath(this);
      await initializeProject(projectPath);
      const config = await readConfig(projectPath);
      const tool = options.tool ?? config.defaultTool;
      const kit = await readKitArtifacts(projectPath);
      const memory = await readMemoryPack(projectPath);
      const adoption = await adoptKitContextPack(projectPath, config);
      const contextFiles =
        adoption?.files ??
        (await scanRelevantFiles({
          projectPath,
          goal,
          blockedPaths: config.blockedPaths
        }));
      const contextOptions: ContextPackOptions = adoption
        ? { source: adoption.source, validationCommands: adoption.validationCommands }
        : {};
      const contextKit = adoption ? { ...kit, warnings: [...kit.warnings, ...adoption.warnings] } : kit;
      const session = await createSession({
        projectPath,
        goal,
        tool,
        relevantFiles: contextFiles.map((file) => file.path)
      });
      const handoff = renderHandoff(session);
      const protocol = buildHandoffProtocol(session);

      await writeText(vispPath(projectPath, "hyper", "current", "session.md"), renderSession(session));
      await writeText(
        vispPath(projectPath, "hyper", "current", "context-pack.md"),
        renderContextPack(contextFiles, contextKit, contextOptions)
      );
      await writeText(vispPath(projectPath, "hyper", "current", "memory-pack.md"), renderMemoryPack(memory));
      await writeText(vispPath(projectPath, "hyper", "current", "quality-gates.md"), renderQualityGates(config.blockedPaths));
      await writeText(vispPath(projectPath, "hyper", "current", "agent-instructions.md"), renderAgentInstructions(session));
      await writeText(
        vispPath(projectPath, "hyper", "current", "handoff.json"),
        `${JSON.stringify({ ...protocol, session }, null, 2)}\n`
      );
      await writeText(join(projectPath, ".visp", "prompts", "visp-hyper-handoff.prompt.md"), `${handoff}\n`);

      console.log(handoff);
    });
}

const maxContentLength = 12_000;

type KitAdoption = {
  files: ContextFile[];
  source: string;
  validationCommands: string[];
  warnings: string[];
};

/**
 * When the external visp kit is available and has an active task with an on-disk
 * context pack, adopt that pack as the context source. Returns `undefined` (so the
 * caller falls back to the relevance scanner) whenever the kit is unavailable, has
 * no active task, exposes no readable pack, or the pack yields zero usable files.
 */
async function adoptKitContextPack(projectPath: string, config: HyperConfig): Promise<KitAdoption | undefined> {
  const kit = await detectVisp(projectPath);
  if (!kit.available) {
    return undefined;
  }
  const activeTaskId = kit.status.activeTask?.id;
  if (!activeTaskId) {
    return undefined;
  }

  const bridge = new KitCommandBridge({ projectPath });
  const pack = await bridge.readContextPack(activeTaskId);
  if (!pack) {
    return undefined;
  }

  const files = await contextFilesFromPack(pack, projectPath, config.blockedPaths);
  if (files.length === 0) {
    return undefined;
  }

  return {
    files,
    source: `visp-kit context pack (${activeTaskId})`,
    validationCommands: pack.validationCommands ?? [],
    warnings: [...kit.warnings, ...bridge.warnings]
  };
}

async function contextFilesFromPack(
  pack: KitContextPack,
  projectPath: string,
  blockedPaths: string[]
): Promise<ContextFile[]> {
  const entries = pack.includedFiles ?? pack.files ?? [];
  const files: ContextFile[] = [];
  for (const entry of entries) {
    if (isBlockedPath(entry.path, blockedPaths)) {
      continue;
    }
    const provided = entry.content ?? entry.snippet;
    const content = provided ?? (await readPackFile(join(projectPath, entry.path)));
    files.push({
      path: entry.path,
      reason: entry.reason ?? "visp-kit context pack",
      content
    });
  }
  return files;
}

async function readPackFile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxContentLength ? `${content.slice(0, maxContentLength)}\n\n[truncated]\n` : content;
  } catch {
    return undefined;
  }
}
