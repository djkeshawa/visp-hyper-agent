import { Command } from "commander";
import { readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { getActiveSession } from "../../core/session-manager.js";
import { resolveProjectPath } from "./shared.js";

const generatedFiles = [
  "session.md",
  "context-pack.md",
  "memory-pack.md",
  "quality-gates.md",
  "agent-instructions.md",
  "handoff.json"
];

export function statusCommand(): Command {
  return new Command("status")
    .description("Show the active Visp Hyper session status.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const session = await getActiveSession(projectPath);
      if (!session) {
        console.log("No active Visp Hyper session.");
        return;
      }
      console.log(`Session: ${session.id}`);
      console.log(`Goal: ${session.goal}`);
      console.log(`Tool: ${session.tool}`);
      console.log(`Phase: ${session.phase}`);
      console.log(`Created: ${session.createdAt}`);
      console.log(`Updated: ${session.updatedAt}`);
      console.log(`Relevant files: ${session.relevantFiles.length}`);
      console.log(`Generated files: ${await generatedFileStatus(projectPath)}`);
      console.log(`Last checkpoint: ${await artifactStatus(projectPath, "checkpoints.md")}`);
      console.log(`Last review: ${await artifactStatus(projectPath, "review-report.md")}`);
      console.log(`Memory: ${await memoryStatus(projectPath, session.id)}`);
    });
}

async function generatedFileStatus(projectPath: string): Promise<string> {
  const statuses = await Promise.all(
    generatedFiles.map(async (file) => (await readTextIfExists(vispPath(projectPath, "hyper", "current", file)) ? file : `${file} (missing)`))
  );
  return statuses.join(", ");
}

async function artifactStatus(projectPath: string, file: string): Promise<string> {
  const content = await readTextIfExists(vispPath(projectPath, "hyper", "current", file));
  return content ? "present" : "missing";
}

async function memoryStatus(projectPath: string, sessionId: string): Promise<string> {
  const content = await readTextIfExists(vispPath(projectPath, "memory", "session-history", `${sessionId}.md`));
  return content ? "remembered" : "not remembered";
}
