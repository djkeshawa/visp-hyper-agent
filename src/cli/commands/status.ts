import { Command } from "commander";
import { checkContextFreshness } from "../../context/context-freshness.js";
import type { ContextFreshness } from "../../context/context-freshness.js";
import { readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { getActiveSession } from "../../core/session-manager.js";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import {
  renderHyperActionFrame,
  toHyperActionEnvelope
} from "../../kit/workflow-action-renderer.js";
import { resolveProjectPath } from "./shared.js";

const generatedFiles = [
  "session.md",
  "context-pack.md",
  "context-manifest.json",
  "memory-pack.md",
  "quality-gates.md",
  "agent-instructions.md",
  "handoff.json"
];

export function statusCommand(): Command {
  return new Command("status")
    .description("Show Kit's canonical action, or local Hyper status in a Kit-less project.")
    .action(async function (this: Command) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: kit.reasonCode,
            reason: kit.reason
          })
        );
        process.exitCode = 1;
        return;
      }
      if (kit.state === "healthy") {
        const bridge = new KitCommandBridge({ projectPath });
        const diagnostic = await bridge.nextCanonicalActionDiagnostic("auto");
        if (!diagnostic.ok) {
          for (const warning of bridge.warnings) console.warn(`warning: ${warning}`);
          console.log(
            renderKitAuthorityStop({
              status: "INCONCLUSIVE",
              reasonCode: diagnostic.reasonCode,
              reason: diagnostic.reason
            })
          );
          process.exitCode = 1;
          return;
        }
        console.log(renderHyperActionFrame(toHyperActionEnvelope(diagnostic.value)));
        if (diagnostic.value.verdict !== "ready") {
          process.exitCode = 1;
        }
        return;
      }
      const session = await getActiveSession(projectPath);
      if (!session) {
        console.log("Authority: local");
        console.log("Assurance: local_checked");
        console.log("No active Visp Hyper session.");
        return;
      }
      console.log("Authority: local");
      console.log("Assurance: local_checked");
      console.log(`Session: ${session.id}`);
      console.log(`Goal: ${session.goal}`);
      console.log(`Tool: ${session.tool}`);
      console.log(`Phase: ${session.phase}`);
      console.log(`Created: ${session.createdAt}`);
      console.log(`Updated: ${session.updatedAt}`);
      console.log(`Relevant files: ${session.relevantFiles.length}`);
      console.log(`Generated files: ${await generatedFileStatus(projectPath)}`);
      console.log(`Context freshness: ${formatContextFreshness(await checkContextFreshness(projectPath))}`);
      console.log(`Last checkpoint: ${await artifactStatus(projectPath, "checkpoints.md")}`);
      console.log(`Last review: ${await artifactStatus(projectPath, "review-report.md")}`);
      console.log(`Memory: ${await memoryStatus(projectPath, session.id)}`);
    });
}

function formatContextFreshness(freshness: ContextFreshness): string {
  const parts: string[] = [freshness.status];
  if (freshness.blocking && freshness.finding) {
    parts.push(`- ${freshness.finding}`);
  }
  if (freshness.warnings.length > 0) {
    parts.push(`warnings: ${freshness.warnings.join("; ")}`);
  }
  return parts.join(" ");
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
