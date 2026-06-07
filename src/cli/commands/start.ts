import { join } from "node:path";
import { Command, Option } from "commander";
import { scanRelevantFiles } from "../../context/relevance-scanner.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { createSession, initializeProject, readConfig } from "../../core/session-manager.js";
import type { ToolProfile } from "../../core/types.js";
import { renderHandoff } from "../../handoff/handoff-protocol.js";
import { readKitArtifacts } from "../../kit/kit-reader.js";
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
      const contextFiles = await scanRelevantFiles({
        projectPath,
        goal,
        blockedPaths: config.blockedPaths
      });
      const session = await createSession({
        projectPath,
        goal,
        tool,
        relevantFiles: contextFiles.map((file) => file.path)
      });
      const handoff = renderHandoff(session);

      await writeText(vispPath(projectPath, "hyper", "current", "session.md"), renderSession(session));
      await writeText(vispPath(projectPath, "hyper", "current", "context-pack.md"), renderContextPack(contextFiles, kit));
      await writeText(vispPath(projectPath, "hyper", "current", "memory-pack.md"), renderMemoryPack(memory));
      await writeText(vispPath(projectPath, "hyper", "current", "quality-gates.md"), renderQualityGates(config.blockedPaths));
      await writeText(vispPath(projectPath, "hyper", "current", "agent-instructions.md"), renderAgentInstructions(session));
      await writeText(
        vispPath(projectPath, "hyper", "current", "handoff.json"),
        `${JSON.stringify({ version: "0.1", session, requiredReads: requiredReads() }, null, 2)}\n`
      );
      await writeText(join(projectPath, ".visp", "prompts", "visp-hyper-handoff.prompt.md"), `${handoff}\n`);

      console.log(handoff);
    });
}

function requiredReads(): string[] {
  return [
    ".visp/hyper/current/session.md",
    ".visp/hyper/current/context-pack.md",
    ".visp/hyper/current/memory-pack.md",
    ".visp/hyper/current/quality-gates.md",
    ".visp/hyper/current/agent-instructions.md"
  ];
}
