import { join } from "node:path";
import { Command, Option } from "commander";
import { packageVersion } from "../../core/package-version.js";
import { fileExists, readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { planInstall, type ToolName } from "../../install/tool-asset-installer.js";
import { detectVisp, hasKitArtifacts, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { handleMessage } from "../../mcp/mcp-server.js";
import { createToolContext } from "../../mcp/tool-bridge.js";
import { contextPackPathIfExists, resolveProjectPath } from "./shared.js";

type DoctorStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  recovery?: string;
};

type DoctorSummary = {
  success: boolean;
  projectPath: string;
  version: string;
  checks: DoctorCheck[];
  nextCommand: string;
};

const GIT_HOOK_MARKER = "# visp-hyper-guard hook";

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check whether Visp Hyper can drive the local Visp Kit workflow.")
    .addOption(new Option("--json", "Print a machine-readable summary."))
    .action(async function (this: Command, options: { json?: boolean }) {
      const projectPath = resolveProjectPath(this);
      const summary = await runDoctor(projectPath);

      if (options.json) {
        console.log(`${JSON.stringify(summary, null, 2)}`);
      } else {
        console.log(formatDoctorSummary(summary));
      }

      if (!summary.success) {
        process.exitCode = 1;
      }
    });
}

export async function runDoctor(projectPath: string): Promise<DoctorSummary> {
  const checks: DoctorCheck[] = [];
  const config = await readHyperConfigSnapshot(projectPath);

  checks.push(checkPackageVersion());
  checks.push(await checkHyperInitialized(projectPath));

  const kitArtifactsPresent = await hasKitArtifacts(projectPath);
  checks.push({
    id: "kit-artifacts",
    label: "Visp Kit artifacts",
    status: kitArtifactsPresent ? "pass" : "warn",
    detail: kitArtifactsPresent
      ? "Found .visp/policy.json or .visp/project.json."
      : "No Kit-owned artifacts found; Hyper will use quick/local mode instead of the strict Kit backend.",
    recovery: kitArtifactsPresent ? undefined : "Run `visp init` or `visp agent bootstrap <tool>` in this project."
  });

  if (kitArtifactsPresent) {
    await checkKitBackend(projectPath, checks);
  }

  checks.push(await checkGitHook(projectPath));
  checks.push(await checkToolAssets(projectPath, config));
  checks.push(await checkMemory(projectPath, config));
  checks.push(await checkMcp(projectPath));

  return {
    success: checks.every((check) => check.status !== "fail"),
    projectPath,
    version: packageVersion(),
    checks,
    nextCommand: nextCommand(checks)
  };
}

function checkPackageVersion(): DoctorCheck {
  const version = packageVersion();
  return {
    id: "hyper-version",
    label: "Visp Hyper version",
    status: version === "0.0.0" ? "warn" : "pass",
    detail: version === "0.0.0"
      ? "Could not resolve package.json version."
      : `Running visp-hyper ${version}.`
  };
}

async function checkHyperInitialized(projectPath: string): Promise<DoctorCheck> {
  const configPath = vispPath(projectPath, "hyper", "config.json");
  const statePath = vispPath(projectPath, "hyper", "state.json");
  const [configExists, stateExists] = await Promise.all([fileExists(configPath), fileExists(statePath)]);
  if (configExists && stateExists) {
    return {
      id: "hyper-state",
      label: "Visp Hyper state",
      status: "pass",
      detail: "Found .visp/hyper/config.json and .visp/hyper/state.json."
    };
  }
  return {
    id: "hyper-state",
    label: "Visp Hyper state",
    status: "fail",
    detail: "Visp Hyper has not been initialized in this project.",
    recovery: "Run `visp-hyper init --tool <tool>`."
  };
}

async function checkKitBackend(projectPath: string, checks: DoctorCheck[]): Promise<void> {
  const availability = await detectVisp(projectPath);
  if (!availability.available) {
    checks.push({
      id: "kit-binary",
      label: "Visp Kit CLI",
      status: "fail",
      detail: availability.reason,
      recovery: "Install or link the `visp` binary, then run `visp status --json`."
    });
    addWarnings(checks, availability.warnings, "kit-detect-warning");
    return;
  }

  checks.push({
    id: "kit-binary",
    label: "Visp Kit CLI",
    status: "pass",
    detail: `Parsed visp status for ${featureLabel(availability.status.activeFeature) ?? "the project"}.`
  });
  addWarnings(checks, availability.warnings, "kit-detect-warning");

  const bridge = new KitCommandBridge({ projectPath });

  const contract = await bridge.integrationContract();
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-contract-warning");
  checks.push(
    contract === null
      ? {
          id: "kit-contract",
          label: "Kit integration contract",
          status: "warn",
          detail: "visp integration contract could not be read; falling back to legacy status and artifact probing.",
          recovery: "Upgrade or link a Visp Kit version that supports `visp integration contract --json`."
        }
      : {
          id: "kit-contract",
          label: "Kit integration contract",
          status: "pass",
          detail: `Contract ${contract.contractVersion} from ${contract.kit.packageName} ${contract.kit.version}; ${formatContractCapabilities(contract)}.`
        }
  );

  const policy = await bridge.policyValidate();
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-policy-warning");
  checks.push(
    policy === null
      ? {
          id: "kit-policy",
          label: "Policy validation",
          status: "fail",
          detail: "visp policy validate output could not be parsed.",
          recovery: "Run `visp policy validate --json` and fix any invalid policy output."
        }
      : {
          id: "kit-policy",
          label: "Policy validation",
          status: policy.success ? "pass" : "fail",
          detail: policy.success
            ? "Policy validates successfully."
            : `Policy validation failed: ${policy.errors.join("; ") || "no error detail reported"}.`,
          recovery: policy.success ? undefined : "Fix .visp/policy.json, then re-run `visp policy validate`."
        }
  );

  const gate = await bridge.gate("next");
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-gate-warning");
  if (gate === null) {
    checks.push({
      id: "kit-next-gate",
      label: "Next gate",
      status: "fail",
      detail: "visp gate next output could not be parsed.",
      recovery: "Run `visp gate next --json` and inspect the output."
    });
  } else {
    checks.push({
      id: "kit-next-gate",
      label: "Next gate",
      status: gate.allowed ? "pass" : "warn",
      detail: gate.allowed
        ? "The next Kit workflow step is allowed."
        : `The Kit gate is currently blocking progress; next allowed command is ${gate.nextAllowedCommand ?? "visp next"}.`,
      recovery: gate.allowed ? undefined : gate.nextAllowedCommand
    });
  }

  const activeTaskId = availability.status.activeTask?.id;
  if (!activeTaskId) {
    checks.push({
      id: "kit-context-pack",
      label: "Task context pack",
      status: "warn",
      detail: "Kit has no active task yet, so there is no task context pack for Hyper to adopt.",
      recovery: "Advance the Kit workflow until `visp status --json` reports an activeTask."
    });
    return;
  }

  const pack = await bridge.readContextPack(activeTaskId);
  const contextPath = await contextPackPathIfExists(projectPath, activeTaskId);
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-context-warning");
  checks.push({
    id: "kit-context-pack",
    label: "Task context pack",
    status: pack ? "pass" : "warn",
    detail: pack
      ? `Read context for ${activeTaskId}${contextPath ? ` at ${contextPath}` : ""}.`
      : `No readable context pack found for active task ${activeTaskId}.`,
    recovery: pack ? undefined : `Run \`visp context --task ${activeTaskId}\`, then re-run \`visp-hyper doctor\`.`
  });
}

type HyperConfigSnapshot = {
  defaultTool?: string;
  memoryMode?: string;
  memoryEndpoint?: string;
};

async function readHyperConfigSnapshot(projectPath: string): Promise<HyperConfigSnapshot | null> {
  const raw = await readTextIfExists(vispPath(projectPath, "hyper", "config.json"));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as HyperConfigSnapshot;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function checkToolAssets(projectPath: string, config: HyperConfigSnapshot | null): Promise<DoctorCheck> {
  const tool = config?.defaultTool;
  if (!isToolName(tool)) {
    return {
      id: "tool-assets",
      label: "Tool assets",
      status: "warn",
      detail: "No valid defaultTool found in .visp/hyper/config.json.",
      recovery: "Run `visp-hyper init --tool <tool>`."
    };
  }

  try {
    const planned = await planInstall(tool, projectPath);
    const missing = planned.filter((asset) => !asset.exists).map((asset) => asset.destination);
    if (missing.length === 0) {
      return {
        id: "tool-assets",
        label: "Tool assets",
        status: "pass",
        detail: `${tool} assets are installed.`
      };
    }
    return {
      id: "tool-assets",
      label: "Tool assets",
      status: "warn",
      detail: `${tool} assets missing: ${missing.join(", ")}.`,
      recovery: `Run \`visp-hyper init --tool ${tool}\`.`
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

async function checkMemory(
  projectPath: string,
  config: HyperConfigSnapshot | null
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

  const endpoint = (config?.memoryEndpoint || "http://localhost:8000").replace(/\/+$/u, "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return {
      id: "memory",
      label: "Memory provider",
      status: "warn",
      detail: `llm-memory endpoint is invalid: ${endpoint}.`,
      recovery: "Run `visp-hyper init --memory-mode file` or set a valid --memory-endpoint."
    };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      id: "memory",
      label: "Memory provider",
      status: "warn",
      detail: `llm-memory endpoint uses unsupported protocol ${url.protocol}.`,
      recovery: "Use an http(s) llm-memory endpoint or switch to file memory."
    };
  }

  try {
    const response = await fetch(`${endpoint}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(750)
    });
    if (!response.ok) {
      return {
        id: "memory",
        label: "Memory provider",
        status: "warn",
        detail: `llm-memory health check returned ${response.status}.`,
        recovery: "Start llm-memory or switch memoryMode to file."
      };
    }
  } catch (error) {
    return {
      id: "memory",
      label: "Memory provider",
      status: "warn",
      detail: `llm-memory unavailable at ${endpoint}: ${error instanceof Error ? error.message : String(error)}.`,
      recovery: "Start llm-memory or switch memoryMode to file."
    };
  }

  return {
    id: "memory",
    label: "Memory provider",
    status: "pass",
    detail: `llm-memory is reachable at ${endpoint}.`
  };
}

async function checkMcp(projectPath: string): Promise<DoctorCheck> {
  try {
    const response = await handleMessage(createToolContext(projectPath), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {}
    }) as { result?: { serverInfo?: { version?: string } } } | null;
    const version = response?.result?.serverInfo?.version;
    if (version !== packageVersion()) {
      return {
        id: "mcp",
        label: "MCP server",
        status: "fail",
        detail: `MCP server version ${version ?? "unknown"} does not match package version ${packageVersion()}.`
      };
    }
    return {
      id: "mcp",
      label: "MCP server",
      status: "pass",
      detail: `MCP initialize responds with version ${version}.`
    };
  } catch (error) {
    return {
      id: "mcp",
      label: "MCP server",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

async function checkGitHook(projectPath: string): Promise<DoctorCheck> {
  const gitDir = join(projectPath, ".git");
  if (!(await fileExists(gitDir))) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "warn",
      detail: "No .git directory found; pre-commit scope enforcement is unavailable.",
      recovery: "Initialize Git or run doctor from the repository root."
    };
  }

  const hook = await readTextIfExists(join(gitDir, "hooks", "pre-commit"));
  if (hook?.includes(GIT_HOOK_MARKER)) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "pass",
      detail: "visp-hyper guard is installed as the pre-commit hook."
    };
  }

  return {
    id: "git-hook",
    label: "Git scope hook",
    status: "warn",
    detail: "visp-hyper guard is not installed as the pre-commit hook.",
    recovery: "Run `visp-hyper hooks git`."
  };
}

function drainWarnings(warnings: string[]): string[] {
  const copy = [...warnings];
  warnings.length = 0;
  return copy;
}

function formatContractCapabilities(contract: {
  capabilities?: {
    governance?: { failClosedGates?: boolean };
    contextGrounding?: { taskScopedContextPacks?: boolean };
    evidence?: { verification?: boolean; review?: boolean; reconciliation?: boolean };
    enforcementSurfaces?: { gitPreCommitHook?: boolean; ciPolicyGate?: boolean };
  };
}): string {
  const capabilities = contract.capabilities;
  if (!capabilities) {
    return "legacy capability metadata unavailable";
  }
  const labels = [
    capabilities.governance?.failClosedGates ? "fail-closed gates" : null,
    capabilities.contextGrounding?.taskScopedContextPacks ? "task context packs" : null,
    capabilities.evidence?.verification && capabilities.evidence.review && capabilities.evidence.reconciliation
      ? "verify/review/reconcile"
      : null,
    capabilities.enforcementSurfaces?.gitPreCommitHook && capabilities.enforcementSurfaces.ciPolicyGate
      ? "git+CI enforcement"
      : null
  ].filter((label): label is string => label !== null);

  return labels.length > 0 ? `capabilities: ${labels.join(", ")}` : "no strict capabilities advertised";
}

function addWarnings(checks: DoctorCheck[], warnings: readonly string[], prefix: string): void {
  for (const [index, warning] of warnings.entries()) {
    checks.push({
      id: `${prefix}-${index + 1}`,
      label: "Bridge warning",
      status: "warn",
      detail: warning
    });
  }
}

function nextCommand(checks: readonly DoctorCheck[]): string {
  const firstAction = checks.find((check) => check.status === "fail" && check.recovery);
  if (firstAction?.recovery) {
    return firstAction.recovery;
  }
  const firstWarning = checks.find((check) => check.status === "warn" && check.recovery);
  return firstWarning?.recovery ?? "visp-hyper run \"<goal>\"";
}

function featureLabel(feature: { id: string; slug?: string } | null | undefined): string | undefined {
  if (!feature) {
    return undefined;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}

function isToolName(value: unknown): value is ToolName {
  return value === "generic" ||
    value === "codex" ||
    value === "claude-code" ||
    value === "copilot" ||
    value === "opencode";
}

function formatDoctorSummary(summary: DoctorSummary): string {
  const lines = [
    "VISP_HYPER_DOCTOR",
    `Project: ${summary.projectPath}`,
    `Version: ${summary.version}`,
    `Overall: ${summary.success ? "PASS" : "FAIL"}`,
    ""
  ];

  for (const check of summary.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
    if (check.recovery) {
      lines.push(`  next: ${check.recovery}`);
    }
  }

  lines.push("", `Next command: ${summary.nextCommand}`);
  return lines.join("\n");
}
