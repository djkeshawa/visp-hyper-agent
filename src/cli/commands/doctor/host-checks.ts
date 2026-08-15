/**
 * Checks over what this project depends on outside itself: the selected coding
 * host binary, the installed tool assets, the memory provider, and whoever
 * serves the intel MCP tools an installed agent declares.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFileResolved, resolveExecutable } from "../../../core/executable-resolver.js";
import { readTextIfExists } from "../../../core/fs-utils.js";
import type { HyperConfig } from "../../../core/types.js";
import { INTEL_MCP_TOOL_PREFIX, MCP_CONFIG_FILENAME, describeIntelProvider } from "../../../install/intel-mcp-registration.js";
import { planInstall, readHostCapabilityManifest } from "../../../install/tool-asset-installer.js";
import type { ToolName } from "../../../install/tool-asset-installer.js";
import type { DoctorCheck } from "./types.js";

export async function checkSelectedHost(projectPath: string, config: HyperConfig | null): Promise<DoctorCheck> {
  const tool = config?.defaultTool;
  if (!tool) {
    return {
      id: "selected-host",
      label: "Selected coding host",
      status: "fail",
      detail: "A trusted defaultTool is unavailable.",
      recovery: "Fix .visp/hyper/config.json, then run `visp setup`."
    };
  }
  if (tool === "generic") {
    return {
      id: "selected-host",
      label: "Selected coding host",
      status: "pass",
      detail: "Generic manual host selected; no host binary is required. Sequential and Git/CI fallbacks apply."
    };
  }
  const executable: Record<Exclude<ToolName, "generic">, string> = {
    "claude-code": "claude",
    codex: "codex",
    copilot: "copilot",
    opencode: "opencode"
  };
  const binary = executable[tool];
  try {
    const { stdout, stderr } = await execFileResolved(binary, ["--version"], {
      cwd: projectPath,
      timeout: 2_000,
      maxBuffer: 64 * 1024
    });
    const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/u)[0]?.trim();
    if (!version) {
      return {
        id: "selected-host",
        label: "Selected coding host",
        status: "warn",
        detail: `${tool} binary ${binary} is available but returned no version.`,
        recovery: `Run \`${binary} --version\` and confirm the host matches the manifest's documented surface.`
      };
    }
    return {
      id: "selected-host",
      label: "Selected coding host",
      status: "pass",
      detail: `${tool} binary ${binary} reports ${version}. Capability compatibility is surface-pinned because no universal minimum host version is documented.`
    };
  } catch (error) {
    return {
      id: "selected-host",
      label: "Selected coding host",
      status: "warn",
      detail: `${tool} binary ${binary} is unavailable or failed its version probe: ${error instanceof Error ? error.message : String(error)}.`,
      recovery: `Install ${tool}, or use the manifest's sequential and Git/CI fallbacks until \`${binary} --version\` succeeds.`
    };
  }
}

export async function checkToolAssets(projectPath: string, config: HyperConfig | null): Promise<DoctorCheck> {
  const tool = config?.defaultTool;
  if (!isToolName(tool)) {
    return {
      id: "tool-assets",
      label: "Tool assets",
      status: "warn",
      detail: "No valid defaultTool found in .visp/hyper/config.json.",
      recovery: "Run `visp setup`."
    };
  }

  try {
    const [{ manifest, sha256 }, planned] = await Promise.all([
      readHostCapabilityManifest(tool),
      planInstall(tool, projectPath)
    ]);
    const missing = planned
      .filter((asset) => asset.integrity === "missing")
      .map((asset) => asset.destination);
    const modified = planned
      .filter((asset) => asset.integrity === "modified")
      .map((asset) => asset.destination);
    const manifestDetail =
      `manifest ${manifest.manifestVersion} ${sha256.slice(0, 12)}; ` +
      `surface ${manifest.validatedAgainst.surface}; ` +
      `validated ${manifest.validatedAgainst.asOf}`;
    if (missing.length === 0 && modified.length === 0) {
      return {
        id: "tool-assets",
        label: "Tool assets",
        status: "pass",
        detail: `${tool} assets are installed and match ${manifestDetail}.`
      };
    }
    const findings = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
      modified.length > 0 ? `modified: ${modified.join(", ")}` : null
    ].filter((finding): finding is string => finding !== null);
    return {
      id: "tool-assets",
      label: "Tool assets",
      status: "warn",
      detail: `${tool} asset integrity differs from ${manifestDetail}: ${findings.join("; ")}.`,
      recovery: `Run \`visp init --tool ${tool} --force-assets\` after reviewing local customizations.`
    };
  } catch (error) {
    return {
      id: "tool-assets",
      label: "Tool assets",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function checkMemory(
  projectPath: string,
  config: HyperConfig | null
): Promise<DoctorCheck> {
  const mode = config?.memoryMode;
  if (mode !== "llm-memory") {
    return {
      id: "memory",
      label: "Memory provider",
      status: "pass",
      detail: "File memory mode is active."
    };
  }

  // Probe the surface the verbs actually use. `recall` and `learn` speak the
  // visp-memory CLI contract in every configuration — the endpoint, when set,
  // is a hint passed through to that CLI, not a transport Hyper owns. Doctor
  // used to fetch `<endpoint>/healthz` itself and reported "llm-memory
  // unavailable at http://localhost:8000" one command after `visp recall` had
  // answered fine through the CLI. A doctor must examine the patient the
  // verbs actually visit: CLI installed, endpoint well-formed when present.
  const resolved = await resolveExecutable("visp-memory");
  if (resolved === null) {
    return {
      id: "memory",
      label: "Memory provider",
      status: "warn",
      detail: "memoryMode is llm-memory, but the visp-memory CLI is not installed.",
      recovery: "Run `visp setup` — it installs what is missing and configures memory here."
    };
  }

  const endpoint = config?.memoryEndpoint?.trim();
  if (endpoint !== undefined && endpoint !== "") {
    let url: URL | null = null;
    try {
      url = new URL(endpoint.replace(/\/+$/u, ""));
    } catch {
      // fall through to the warning below
    }
    if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return {
        id: "memory",
        label: "Memory provider",
        status: "warn",
        detail: `llm-memory endpoint is invalid: ${endpoint}.`,
        recovery: "Run `visp init --memory-mode file` or set a valid --memory-endpoint."
      };
    }
  }

  return {
    id: "memory",
    label: "Memory provider",
    status: "pass",
    detail: "llm-memory is available through the visp-memory CLI."
  };
}

/**
 * A3. Does anything provide the MCP tools an installed agent declares?
 *
 * Scoped to a declaration that actually exists on disk: a project with no
 * `mcp__visp-intel__*` consumer needs no provider, and warning there would be
 * noise. When the declaration IS installed and nothing registers the server,
 * the scout lane is a silent no-op — it cannot obtain a receipt, so every row
 * it produces is dropped and the coordinator sees an empty result that looks
 * like an answer. That is the case worth a warning.
 *
 * `warn`, not `fail`: intel is optional, and a project may deliberately run the
 * workflow without the navigation lane. What is not acceptable is running it
 * without knowing.
 */
export async function checkIntelMcpProvider(projectPath: string): Promise<DoctorCheck> {
  const consumers = await agentsDeclaringIntelTools(projectPath);
  const status = await describeIntelProvider(projectPath);

  if (consumers.length === 0) {
    return {
      id: "intel-mcp",
      label: "Intel MCP provider",
      status: "pass",
      detail: status.registered
        ? `${status.serverName} is registered in ${MCP_CONFIG_FILENAME}; no installed agent declares its tools yet.`
        : `No installed agent declares ${INTEL_MCP_TOOL_PREFIX}* tools, so none needs a provider.`
    };
  }
  if (status.registered) {
    return {
      id: "intel-mcp",
      label: "Intel MCP provider",
      status: "pass",
      detail: `${consumers.join(", ")} ${declares(consumers)} ${INTEL_MCP_TOOL_PREFIX}* tools and ${MCP_CONFIG_FILENAME} registers ${status.serverName}.`
    };
  }
  return {
    id: "intel-mcp",
    label: "Intel MCP provider",
    status: "warn",
    detail:
      `${consumers.join(", ")} ${declares(consumers)} ${INTEL_MCP_TOOL_PREFIX}* tools, but ${status.reason}. ` +
      "The scout lane cannot obtain an intel receipt, so its rows are dropped and the coordinator " +
      "reads an empty result that is indistinguishable from intel finding nothing.",
    recovery:
      "Index the repository with `visp-intel repo index`, then run " +
      "`visp init --intel-store <path> --intel-repository <id>` to register the server."
  };
}

function declares(consumers: readonly string[]): string {
  return consumers.length === 1 ? "declares" : "declare";
}

/** Installed agent files whose front matter asks for the intel tool namespace. */
async function agentsDeclaringIntelTools(projectPath: string): Promise<string[]> {
  const agentsDir = join(projectPath, ".claude", "agents");
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  const declaring: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    const text = await readTextIfExists(join(agentsDir, entry));
    if (text?.includes(INTEL_MCP_TOOL_PREFIX)) {
      declaring.push(`.claude/agents/${entry}`);
    }
  }
  return declaring;
}

function isToolName(value: unknown): value is ToolName {
  return value === "generic" ||
    value === "codex" ||
    value === "claude-code" ||
    value === "copilot" ||
    value === "opencode";
}
