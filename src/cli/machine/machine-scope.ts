import { access } from "node:fs/promises";
import { join } from "node:path";

import { readTextIfExists, vispPath, writeText } from "../../core/fs-utils.js";
import { execFileResolved, resolveExecutable } from "../../core/executable-resolver.js";
import { initializeProject, readConfig } from "../../core/session-manager.js";
import {
  INTEL_MCP_TOOL_PREFIX,
  MCP_CONFIG_FILENAME,
  describeIntelProvider,
  registerIntelMcpServer
} from "../../install/intel-mcp-registration.js";
import { KitCommandBridge, hasKitArtifacts } from "../../kit/kit-command-bridge.js";

// P10-US-05/08: the machine-scope boundary.
//
// `setup` and `doctor` are the only verbs allowed to load the Visp Dev
// machine-scope adapter (visp-dev ADR 0001, accepted D-116). Project verbs
// never resolve it — a test enforces that. The adapter is loaded dynamically
// so a project-verb import graph can never pull it in by accident.

export const MACHINE_ADAPTER_SPECIFIER = "visp-dev/machine-scope";

type MachineScopeAdapter = {
  readonly runSetup: (input: {
    readonly projectPath: string;
    readonly args: readonly string[];
  }) => Promise<{ readonly success: boolean; readonly report: string }>;
};

async function loadAdapter(): Promise<MachineScopeAdapter | null> {
  try {
    const loaded = (await import(MACHINE_ADAPTER_SPECIFIER)) as Partial<MachineScopeAdapter>;
    if (typeof loaded.runSetup === "function") return loaded as MachineScopeAdapter;
    return null;
  } catch {
    return null;
  }
}

export async function runSetupVerb(projectPath: string, args: readonly string[]): Promise<void> {
  const adapter = await loadAdapter();
  if (adapter === null) {
    console.error(
      [
        "visp setup needs the Visp Dev machine-scope adapter, which is not installed.",
        "Install it with: npm install -g visp-dev",
        "Then re-run: visp setup"
      ].join("\n")
    );
    process.exitCode = 1;
    return;
  }
  const result = await adapter.runSetup({ projectPath, args });
  console.log(result.report);
  if (!result.success) {
    process.exitCode = 1;
    return;
  }

  // The adapter's report already ends with "Setup complete", and until now that
  // was the last word — which is exactly why it was untrue. The project work
  // happens here, in the same command, so by the time the user reads that line
  // it has been earned.
  await completeProjectScope(projectPath);
}

/**
 * Finish the job `setup` has always claimed to have done.
 *
 * `runSetupVerb` used to check the machine, print the report, and stop —
 * writing nothing into the project. That single omission produced both of the
 * contradictions dogfooding found, within a minute of each other:
 *
 *   $ visp setup     Setup complete. Run visp doctor any time to re-verify.
 *   $ visp new "…"   Visp Kit is installed, but this project is not initialised.
 *
 *   $ visp setup     visp-memory 0.4.1 — ok (recall/learn available).
 *   $ visp recall …  visp recall needs visp-memory, which is not configured
 *                    for this project.
 *
 * Neither was a bug in `new` or in `recall`. The project had never been
 * initialised and `memoryMode` was still at its "file" default, because
 * nothing had set them. "Setup complete" was simply not true.
 *
 * Everything here is idempotent and additive: Kit's init skips files that
 * exist, Hyper's writes config only when absent, and no `--force` is passed
 * anywhere — `visp-kit init --force` regenerates status.json and policy.json,
 * which would destroy workflow progress.
 */
async function completeProjectScope(projectPath: string): Promise<void> {
  const done: string[] = [];

  if (!(await hasKitArtifacts(projectPath))) {
    const bridge = new KitCommandBridge({ projectPath });
    const initialised = await bridge.runMechanicalArgv("init", []);
    if (initialised?.success === true) {
      done.push("initialised Visp Kit in this project");
    } else {
      // Do not claim completion we did not achieve — that is the defect being
      // repaired. Name the one command that finishes the job.
      console.log(
        "warning: could not initialise Visp Kit here. Run `visp-kit init` in this project."
      );
    }
  }

  if (!(await pathExists(vispPath(projectPath, "hyper", "config.json")))) {
    await initializeProject(projectPath, false);
    done.push("initialised Visp Hyper in this project");
  }

  // Assets too, not just config. Initialising Hyper without its default tool
  // assets left `visp doctor` WARNing about missing files ("missing:
  // visp-hyper-instructions.md") seconds after setup said it was done — and
  // its remedy was a hidden command. The default host is generic; a specific
  // tool remains an explicit `visp-hyper init --tool <tool>` choice.
  if (await installGenericAssets(projectPath)) {
    done.push("installed the generic tool assets");
  }

  if (await initialiseMemoryStore(projectPath)) {
    done.push("initialised the visp-memory store in this project");
  }

  if (await enableLlmMemory(projectPath)) {
    done.push('set memoryMode to "llm-memory" (visp-memory is installed and initialised here)');
  }

  const intel = await registerConfiguredIntelServer(projectPath);
  if (intel !== null) done.push(intel);

  for (const line of done) console.log(`  ${line}`);

  await reportIntelProviderGap(projectPath);
}

/**
 * A3: re-assert the registration `setup` has always implied but never made.
 *
 * Only from a scope already recorded in config — `setup` configures what is
 * installed, it does not index a repository or invent a store path. A project
 * that has never run `visp-intel repo index` gets the report below instead.
 */
async function registerConfiguredIntelServer(projectPath: string): Promise<string | null> {
  const configPath = vispPath(projectPath, "hyper", "config.json");
  if (!(await pathExists(configPath))) return null;
  const config = await readConfig(projectPath);
  if (config.intelStore === undefined || config.intelRepository === undefined) return null;

  const result = await registerIntelMcpServer(projectPath, {
    store: config.intelStore,
    repository: config.intelRepository
  });
  if (result.outcome === "refused") {
    console.log(`warning: could not register the visp-intel MCP server: ${result.reason}`);
    return null;
  }
  return result.outcome === "unchanged"
    ? null
    : `${result.outcome} the visp-intel MCP server in ${MCP_CONFIG_FILENAME}`;
}

/**
 * Say it out loud when `setup` has just installed an agent that asks for tools
 * nothing provides.
 *
 * This is the same class of untruth the rest of this file exists to repair:
 * "Setup complete" while the navigation lane it just installed cannot run. The
 * difference from the other cases is that this one never surfaces later either
 * — the scout simply returns nothing, and nothing looks like an answer.
 */
async function reportIntelProviderGap(projectPath: string): Promise<void> {
  const status = await describeIntelProvider(projectPath);
  if (status.registered) return;
  const scout = join(projectPath, ".claude", "agents", "scout.md");
  const text = await readTextIfExists(scout);
  if (text === undefined || !text.includes(INTEL_MCP_TOOL_PREFIX)) return;

  console.log(
    [
      `warning: .claude/agents/scout.md declares ${status.declaredTools.length} ${INTEL_MCP_TOOL_PREFIX}* tools and ${status.reason}.`,
      "         The scout lane will return nothing, and nothing is indistinguishable from a real negative answer.",
      "         Index the repository with `visp-intel repo index`, then run",
      "         `visp init --intel-store <path> --intel-repository <id>`."
    ].join("\n")
  );
}

/**
 * Create the project's memory store when visp-memory is installed but has
 * never been initialised here.
 *
 * This is the missing first domino behind the setup/recall contradiction on a
 * FRESH project: `enableLlmMemory` (correctly) refuses to point `recall` at a
 * store that does not exist, but nothing ever created one — so setup still
 * printed "recall/learn available" and recall still said "not configured",
 * exactly the pair of sentences this whole path exists to prevent.
 * `visp-memory init` is idempotent, writes visp-memory.yaml beside the
 * project, and gitignores its own store.
 */
/**
 * Install the generic (host-neutral) tool assets when none were ever
 * installed. Never forces: an existing installation, customised or not,
 * belongs to the user and to `visp-hyper init --tool <tool> --force-assets`.
 */
async function installGenericAssets(projectPath: string): Promise<boolean> {
  try {
    const { installAssets } = await import("../../install/tool-asset-installer.js");
    const report = await installAssets("generic", projectPath, { force: false });
    return report.created.length > 0;
  } catch {
    console.log(
      "warning: could not install the generic tool assets. Run `visp-hyper init --tool generic`."
    );
    return false;
  }
}

async function initialiseMemoryStore(projectPath: string): Promise<boolean> {
  if (await pathExists(join(projectPath, "visp-memory.yaml"))) return false;
  if ((await resolveExecutable("visp-memory")) === null) return false;

  try {
    await execFileResolved("visp-memory", ["init"], { cwd: projectPath, timeout: 120_000 });
  } catch {
    console.log(
      "warning: could not initialise the visp-memory store here. Run `visp-memory init` in this project."
    );
    return false;
  }
  return pathExists(join(projectPath, "visp-memory.yaml"));
}

/**
 * Point Hyper's memory verbs at visp-memory when it is genuinely usable here.
 *
 * Two conditions, both required, because the failure this repairs was `setup`
 * certifying a capability `recall` then denied. The binary being installed is
 * not enough — an uninitialised store would make `visp recall` fail in a new
 * way rather than the old one.
 */
async function enableLlmMemory(projectPath: string): Promise<boolean> {
  const configPath = vispPath(projectPath, "hyper", "config.json");
  if (!(await pathExists(configPath))) return false;
  if (!(await pathExists(join(projectPath, "visp-memory.yaml")))) return false;

  const resolved = await resolveExecutable("visp-memory");
  if (resolved === null) return false;

  const config = await readConfig(projectPath);
  if (config.memoryMode === "llm-memory") return false;

  config.memoryMode = "llm-memory";
  await writeText(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return true;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}
