import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Command, Option } from "commander";
import { resolveProjectPath } from "./shared.js";
import { initializeProject } from "../../core/session-manager.js";
import { installAssets, type ToolName } from "../../install/tool-asset-installer.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";

interface InitOptions {
  force?: boolean;
  tool?: ToolName;
  forceAssets?: boolean;
  withHooks?: boolean;
}

export function initCommand(): Command {
  return new Command("init")
    .description("Create local Visp Hyper configuration and state files.")
    .option("--force", "Overwrite existing generated config and state.")
    .addOption(
      new Option("--tool <tool>", "Install agent assets for a coding tool.").choices([
        "generic",
        "codex",
        "claude-code",
        "copilot",
        "opencode"
      ])
    )
    .option("--force-assets", "Overwrite existing installed tool assets.")
    .option("--with-hooks", "Install the visp Claude Code PreToolUse hook (claude-code only).")
    .action(async function (this: Command, options: InitOptions) {
      const projectPath = resolveProjectPath(this);
      await initializeProject(projectPath, Boolean(options.force));
      console.log(`Initialized Visp Hyper at ${projectPath}`);

      if (!options.tool) {
        return;
      }
      const tool = options.tool;

      if (tool !== "claude-code" && options.withHooks) {
        console.log("warning: --with-hooks applies to claude-code only; ignoring.");
      }

      const report = await installAssets(tool, projectPath, { force: options.forceAssets });
      printReport(tool, report);

      if (tool !== "claude-code") {
        return;
      }

      await wireHooks(projectPath, Boolean(options.withHooks));
    });
}

function printReport(
  tool: ToolName,
  report: { created: string[]; skipped: string[]; overwritten: string[]; warnings: string[] }
): void {
  console.log(`Installed ${tool} assets:`);
  for (const path of report.created) {
    console.log(`  created: ${path}`);
  }
  for (const path of report.skipped) {
    console.log(`  skipped (exists): ${path}`);
  }
  for (const path of report.overwritten) {
    console.log(`  overwritten: ${path}`);
  }
  for (const warning of report.warnings) {
    console.log(`warning: ${warning}`);
  }
}

async function wireHooks(projectPath: string, withHooks: boolean): Promise<void> {
  // `visp status` reports initialized=true for any .visp/ directory, including
  // the one visp-hyper's own init just created. Require a kit-owned artifact
  // so the hook hint only appears in projects with a real Visp Kit.
  if (!(await hasKitArtifacts(projectPath))) {
    return;
  }
  const kit = await detectVisp(projectPath);
  if (!kit.available) {
    return;
  }

  if (!withHooks) {
    console.log("hint: run `visp hooks claude` to enforce task scopes mechanically (PreToolUse gate).");
    return;
  }

  const bridge = new KitCommandBridge({ projectPath });
  const result = await bridge.hooksClaude();
  if (result?.success) {
    console.log("hooks: installed via visp hooks claude");
  } else {
    console.log("warning: visp hooks claude failed; run it manually.");
  }
}

async function hasKitArtifacts(projectPath: string): Promise<boolean> {
  for (const artifact of ["policy.json", "project.json"]) {
    try {
      await stat(join(projectPath, ".visp", artifact));
      return true;
    } catch {
      // keep probing
    }
  }
  return false;
}
