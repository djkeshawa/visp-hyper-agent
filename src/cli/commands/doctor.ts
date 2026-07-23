import { createHash } from "node:crypto";
import { join } from "node:path";
import { Command, Option } from "commander";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { packageVersion } from "../../core/package-version.js";
import { fileExists, readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { planInstall, type ToolName } from "../../install/tool-asset-installer.js";
import { provenanceFreshnessContractWarning } from "../../kit/kit-contract-compat.js";
import { detectVisp, hasKitArtifacts, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import type { KitIntegrationContract } from "../../kit/kit-schemas.js";
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
  checks.push(await checkActiveContextFreshness(projectPath));

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

async function checkActiveContextFreshness(projectPath: string): Promise<DoctorCheck> {
  const freshness = await checkContextFreshness(projectPath);
  const warnings = freshness.warnings.length > 0
    ? ` Warnings: ${freshness.warnings.join("; ")}`
    : "";

  if (freshness.blocking) {
    return {
      id: "context-freshness",
      label: "Active context freshness",
      status: "fail",
      detail: `${freshness.finding ?? `Context freshness is ${freshness.status}.`}${warnings}`,
      recovery: "Regenerate the handoff with `visp-hyper run \"<goal>\"`."
    };
  }

  if (freshness.status === "current") {
    return {
      id: "context-freshness",
      label: "Active context freshness",
      status: freshness.warnings.length > 0 ? "warn" : "pass",
      detail: freshness.warnings.length > 0
        ? `Current context hashes are fresh, but freshness is degraded.${warnings}`
        : "Current context artifact and provenance hashes are fresh."
    };
  }

  return {
    id: "context-freshness",
    label: "Active context freshness",
    status: "warn",
    detail: `${freshness.warnings.join("; ") || "No active context freshness metadata is available."}`
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
  if (contract === null) {
    checks.push({
      id: "kit-contract",
      label: "Kit integration contract",
      status: "warn",
      detail: "visp integration contract could not be read; falling back to legacy status and artifact probing.",
      recovery: "Upgrade or link a Visp Kit version that supports `visp integration contract --json`."
    });
    checks.push({
      id: "kit-workflow-action",
      label: "Kit WorkflowAction protocol",
      status: "fail",
      detail: "integration_contract_unavailable: no supported Kit contract is available for WorkflowAction negotiation.",
      recovery: "Upgrade or link a compatible Visp Kit, then re-run `visp-hyper doctor`."
    });
  } else {
    const provenanceWarning = provenanceFreshnessContractWarning(contract);
    checks.push({
      id: "kit-contract",
      label: "Kit integration contract",
      status: provenanceWarning ? "warn" : "pass",
      detail: [
        `Contract ${contract.contractVersion} from ${contract.kit.packageName} ${contract.kit.version}; ${formatContractCapabilities(contract)}.`,
        provenanceWarning
      ].filter((line): line is string => typeof line === "string").join(" "),
      recovery: provenanceWarning
        ? "Upgrade or link a Visp Kit version that supports integration contract 1.2 provenance freshness."
        : undefined
    });
    const activeReadContract = await checkActiveKitReadContract(projectPath, contract);
    if (activeReadContract) {
      checks.push(activeReadContract);
    }

    const action = await bridge.nextCanonicalActionDiagnostic("auto", contract);
    addWarnings(checks, drainWarnings(bridge.warnings), "kit-workflow-action-warning");
    if (!action.ok) {
      checks.push({
        id: "kit-workflow-action",
        label: "Kit WorkflowAction protocol",
        status: "fail",
        detail: `${action.reasonCode}: ${action.reason}`,
        recovery: "Link a Kit/Hyper pair with matching WorkflowAction advertisement, schema, and action identity."
      });
    } else {
      const { source } = action.value;
      checks.push({
        id: "kit-workflow-action",
        label: "Kit WorkflowAction protocol",
        status: "pass",
        detail: [
          `Kit ${contract.kit.packageName} ${contract.kit.version}; integration contract ${contract.contractVersion}.`,
          `Selected protocol ${source.protocolVersion} via ${source.selectionMode}.`,
          `Local schema hash ${source.localSchemaHash}; verification state ${source.schemaHashVerification.state}.`,
          `Authoritative action verdict ${action.value.verdict}.`,
          "Configured strict surfaces consume this negotiated canonical action."
        ].join(" ")
      });
    }
  }

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
    const ctx = createToolContext(projectPath);
    const response = await handleMessage(ctx, {
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
    const manifestResponse = await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri: "visp-hyper://meta/surface-manifest" }
    }) as { result?: { contents?: Array<{ text?: string }> } } | null;
    const manifest = parseSurfaceManifest(manifestResponse?.result?.contents?.[0]?.text);
    if (!manifest) {
      return {
        id: "mcp",
        label: "MCP server",
        status: "fail",
        detail: "MCP initialize passed, but the surface manifest could not be read or parsed."
      };
    }
    if (manifest.serverInfo?.version !== packageVersion()) {
      return {
        id: "mcp",
        label: "MCP server",
        status: "fail",
        detail: `MCP surface manifest version ${manifest.serverInfo?.version ?? "unknown"} does not match package version ${packageVersion()}.`
      };
    }
    const surfaceHash = manifest.surfaceHash;
    if (typeof surfaceHash !== "string" || !/^[a-f0-9]{64}$/u.test(surfaceHash)) {
      return {
        id: "mcp",
        label: "MCP server",
        status: "fail",
        detail: "MCP surface manifest is missing a valid sha256 surface hash."
      };
    }
    const toolsResponse = await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list"
    }) as { result?: { tools?: unknown[] } } | null;
    const contractProblem = validateMcpToolContracts(manifest.tools, toolsResponse?.result?.tools);
    if (contractProblem) {
      return {
        id: "mcp",
        label: "MCP server",
        status: "fail",
        detail: contractProblem
      };
    }
    return {
      id: "mcp",
      label: "MCP server",
      status: "pass",
      detail: `MCP initialize responds with version ${version}; surface hash ${surfaceHash.slice(0, 12)} covers ${manifest.tools?.length ?? 0} tools with input/output schemas.`
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

function parseSurfaceManifest(text: string | undefined): {
  surfaceHash?: string;
  serverInfo?: { version?: string };
  tools?: unknown[];
} | null {
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as {
      surfaceHash?: string;
      serverInfo?: { version?: string };
      tools?: unknown[];
    };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function validateMcpToolContracts(manifestTools: unknown[] | undefined, listedTools: unknown[] | undefined): string | null {
  if (!Array.isArray(manifestTools) || manifestTools.length === 0) {
    return "MCP surface manifest does not list any tools.";
  }
  if (!Array.isArray(listedTools) || listedTools.length === 0) {
    return "MCP tools/list did not return any tools.";
  }

  const listedByName = new Map<string, Record<string, unknown>>();
  for (const tool of listedTools) {
    if (!tool || typeof tool !== "object") {
      return "MCP tools/list returned a malformed tool entry.";
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      return "MCP tools/list returned a tool without a valid name.";
    }
    listedByName.set(record.name, record);
  }

  for (const tool of manifestTools) {
    if (!tool || typeof tool !== "object") {
      return "MCP surface manifest contains a malformed tool entry.";
    }
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      return "MCP surface manifest contains a tool without a valid name.";
    }
    if (!isSha256(record.inputSchemaHash) || !isSha256(record.outputSchemaHash)) {
      return `MCP surface manifest tool ${record.name} is missing valid input/output schema hashes.`;
    }
    const listed = listedByName.get(record.name);
    if (!listed) {
      return `MCP surface manifest tool ${record.name} is not advertised by tools/list.`;
    }
    if (!listed.inputSchema || typeof listed.inputSchema !== "object") {
      return `MCP tool ${record.name} does not advertise an input schema.`;
    }
    if (!listed.outputSchema || typeof listed.outputSchema !== "object") {
      return `MCP tool ${record.name} does not advertise an output schema.`;
    }
    if (hashStable(listed.inputSchema) !== record.inputSchemaHash) {
      return `MCP tool ${record.name} input schema hash does not match the surface manifest.`;
    }
    if (hashStable(listed.outputSchema) !== record.outputSchemaHash) {
      return `MCP tool ${record.name} output schema hash does not match the surface manifest.`;
    }
  }

  const manifestNames = new Set(
    manifestTools
      .filter((tool): tool is Record<string, unknown> => Boolean(tool) && typeof tool === "object")
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string")
  );
  for (const name of listedByName.keys()) {
    if (!manifestNames.has(name)) {
      return `MCP tools/list advertises ${name}, but the surface manifest does not include it.`;
    }
  }

  return null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

async function checkActiveKitReadContract(
  projectPath: string,
  contract: KitIntegrationContract
): Promise<DoctorCheck | null> {
  if (!kitAdvertisesReadContract(contract)) {
    return null;
  }

  const recovery = "Regenerate the active handoff with `visp-hyper run \"<goal>\"`.";
  const manifestPath = vispPath(projectPath, "hyper", "current", "context-manifest.json");
  const manifestText = await readTextIfExists(manifestPath);

  if (!manifestText) {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: "Kit advertises orchestrator read contracts, but the active Hyper handoff has no context manifest yet.",
      recovery
    };
  }

  let manifest: { kitReadContract?: unknown };
  try {
    manifest = JSON.parse(manifestText) as { kitReadContract?: unknown };
  } catch {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: "Active context manifest is unreadable; cannot confirm the Kit read contract.",
      recovery
    };
  }

  if (!manifest.kitReadContract || typeof manifest.kitReadContract !== "object") {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: "Kit advertises orchestrator read contracts, but the active Hyper handoff does not carry kitReadContract.",
      recovery
    };
  }

  const active = manifest.kitReadContract as Record<string, unknown>;
  const activeContractVersion = typeof active.contractVersion === "string" ? active.contractVersion : undefined;
  const activeReadVersion = typeof active.readContractVersion === "string" ? active.readContractVersion : undefined;
  const requiredArtifacts = Array.isArray(active.requiredArtifacts) ? active.requiredArtifacts : undefined;
  const expectedReadVersion = contract.orchestrator?.readContractVersion;

  if (!activeContractVersion || !activeReadVersion || !requiredArtifacts) {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: "Active Hyper handoff carries an incomplete kitReadContract record.",
      recovery
    };
  }

  if (activeContractVersion !== contract.contractVersion) {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: `Active handoff was generated from Kit contract ${activeContractVersion}, but the current Kit contract is ${contract.contractVersion}.`,
      recovery
    };
  }

  if (expectedReadVersion && activeReadVersion !== expectedReadVersion) {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "warn",
      detail: `Active handoff carries Kit read contract ${activeReadVersion}, but the current Kit read contract is ${expectedReadVersion}.`,
      recovery
    };
  }

  return {
    id: "kit-read-contract",
    label: "Active Kit read contract",
    status: "pass",
    detail: `Active handoff carries Kit read contract ${activeReadVersion} with ${requiredArtifacts.length} required artifacts.`
  };
}

function kitAdvertisesReadContract(contract: KitIntegrationContract): boolean {
  return Boolean(
    contract.capabilities?.contextGrounding?.orchestratorReadContract &&
      contract.orchestrator?.readContractVersion &&
      Array.isArray(contract.orchestrator.requiredArtifacts)
  );
}

function formatContractCapabilities(contract: {
  capabilities?: {
    governance?: { failClosedGates?: boolean };
    contextGrounding?: {
      taskScopedContextPacks?: boolean;
      artifactProvenance?: boolean;
      orchestratorReadContract?: boolean;
    };
    evidence?: { verification?: boolean; review?: boolean; reconciliation?: boolean };
    enforcementSurfaces?: { gitPreCommitHook?: boolean; ciPolicyGate?: boolean };
  };
  orchestrator?: {
    readContractVersion?: string;
    requiredArtifacts?: unknown[];
  };
  workflow?: {
    freshnessChecks?: string[];
  };
}): string {
  const capabilities = contract.capabilities;
  if (!capabilities) {
    return "legacy capability metadata unavailable";
  }
  const labels = [
    capabilities.governance?.failClosedGates ? "fail-closed gates" : null,
    capabilities.contextGrounding?.taskScopedContextPacks ? "task context packs" : null,
    capabilities.contextGrounding?.artifactProvenance ? "artifact provenance" : null,
    capabilities.contextGrounding?.orchestratorReadContract &&
      contract.orchestrator?.readContractVersion &&
      Array.isArray(contract.orchestrator.requiredArtifacts)
      ? `orchestrator read contract ${contract.orchestrator.readContractVersion} (${contract.orchestrator.requiredArtifacts.length} artifacts)`
      : null,
    capabilities.evidence?.verification && capabilities.evidence.review && capabilities.evidence.reconciliation
      ? "verify/review/reconcile"
      : null,
    contract.workflow?.freshnessChecks?.includes("contextPack.artifactProvenance[]")
      ? "provenance freshness"
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
