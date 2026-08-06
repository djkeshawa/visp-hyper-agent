import { access } from "node:fs/promises";
import { join } from "node:path";

import { vispPath, writeText } from "../../core/fs-utils.js";
import { resolveExecutable } from "../../core/executable-resolver.js";
import { initializeProject, readConfig } from "../../core/session-manager.js";
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

  if (await enableLlmMemory(projectPath)) {
    done.push('set memoryMode to "llm-memory" (visp-memory is installed and initialised here)');
  }

  for (const line of done) console.log(`  ${line}`);
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
