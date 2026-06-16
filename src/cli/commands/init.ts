import { Command, Option } from "commander";
import { resolveProjectPath } from "./shared.js";
import { initializeProject, readConfig } from "../../core/session-manager.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { repoIdForProject } from "../../memory/llm-memory-provider.js";
import { installAssets, type ToolName } from "../../install/tool-asset-installer.js";
import { KitCommandBridge, detectVisp, hasKitArtifacts } from "../../kit/kit-command-bridge.js";

interface InitOptions {
  force?: boolean;
  tool?: ToolName;
  forceAssets?: boolean;
  withHooks?: boolean;
  memoryEndpoint?: string;
  memoryMode?: "file" | "llm-memory";
  memoryRepoId?: string;
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
    .option("--memory-endpoint <url>", "Configure the hosted llm-memory server endpoint.")
    .addOption(new Option("--memory-mode <mode>", "Set the memory mode.").choices(["file", "llm-memory"]))
    .option("--memory-repo-id <id>", "Pin a stable repo id shared across teammate clones.")
    .action(async function (this: Command, options: InitOptions) {
      const projectPath = resolveProjectPath(this);

      if (options.memoryEndpoint && !/^https?:\/\//u.test(options.memoryEndpoint)) {
        console.error("error: --memory-endpoint must be an http(s) URL.");
        process.exitCode = 1;
        return;
      }

      await initializeProject(projectPath, Boolean(options.force));
      console.log(`Initialized Visp Hyper at ${projectPath}`);

      await applyMemoryConfig(projectPath, options);

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
        console.log("hint: run `visp-hyper hooks git` to block out-of-scope commits mechanically.");
        return;
      }

      await wireHooks(projectPath, Boolean(options.withHooks));
    });
}

async function applyMemoryConfig(projectPath: string, options: InitOptions): Promise<void> {
  if (!options.memoryEndpoint && !options.memoryMode && options.memoryRepoId === undefined) {
    return;
  }

  const config = await readConfig(projectPath);

  if (options.memoryEndpoint) {
    config.memoryEndpoint = options.memoryEndpoint;
  }

  if (options.memoryMode) {
    config.memoryMode = options.memoryMode;
  } else if (options.memoryEndpoint) {
    config.memoryMode = "llm-memory";
  }

  if (options.memoryRepoId !== undefined) {
    const normalized = normalizeRepoId(options.memoryRepoId);
    if (normalized !== options.memoryRepoId) {
      console.log(`note: repo id normalized to ${normalized}`);
    }
    config.memoryRepoId = normalized;
  }

  if (options.memoryMode === "file" && options.memoryEndpoint) {
    console.log("note: memory endpoint stored but inert while memoryMode is file.");
  }

  await writeText(vispPath(projectPath, "hyper", "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const repoId = config.memoryRepoId ? config.memoryRepoId : `derived (${repoIdForProject(projectPath)})`;
  console.log(`memory: mode=${config.memoryMode} endpoint=${config.memoryEndpoint} repo_id=${repoId}`);
}

function normalizeRepoId(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, "-");
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

