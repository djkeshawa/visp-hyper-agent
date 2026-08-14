// A3: the provider behind the scout's declared tool surface.
//
// `visp setup` installs a `scout` subagent whose front matter declares five
// `mcp__visp-intel__*` tools. Until this module existed, nothing in any Visp
// product wrote `.mcp.json`, so the host had no provider for that namespace.
// The consequence was not an error — it was silence: the scout could obtain no
// query receipt, the collector dropped every unreceipted row, and the
// coordinator read an empty `accepted` list that looks exactly like "intel
// looked and found nothing".
//
// Two duties live here, and only these two:
//   1. REGISTER — merge a `visp-intel` entry into the project's `.mcp.json`,
//      never clobbering another server and never overwriting a file we cannot
//      parse.
//   2. DESCRIBE — answer, with a reason, whether a provider exists for the
//      declared namespace, so absence can be reported instead of inferred.
//
// This module registers a server. It does not index a repository, does not
// query intel, and authorizes nothing.

import { join } from "node:path";

import { execFileResolved } from "../core/executable-resolver.js";
import { fileExists, readTextIfExists, writeText } from "../core/fs-utils.js";

/** The MCP server key. Host tools namespace tools as `mcp__<serverKey>__<tool>`. */
export const INTEL_MCP_SERVER_NAME = "visp-intel";

/** The namespace the scout's declared tools must live in for a provider to match. */
export const INTEL_MCP_TOOL_PREFIX = `mcp__${INTEL_MCP_SERVER_NAME}__`;

export const MCP_CONFIG_FILENAME = ".mcp.json";

/**
 * The exact tool surface `templates/claude-code/agents/scout.md` declares.
 *
 * Duplicated from the template on purpose, with a test
 * (`tests/intel-mcp-registration.test.ts`) that fails the moment the two
 * disagree. The template is what the host reads and this list is what the
 * installer promises to provide; a drift between them is precisely the defect
 * this module exists to close, so it must be caught mechanically rather than
 * avoided by having only one copy nobody checks.
 */
export const SCOUT_DECLARED_INTEL_TOOLS = [
  "mcp__visp-intel__intel_search",
  "mcp__visp-intel__intel_entity",
  "mcp__visp-intel__intel_neighbors",
  "mcp__visp-intel__intel_trace_path",
  "mcp__visp-intel__intel_tests_for"
] as const;

const BINARY_PROBE_TIMEOUT_MS = 5_000;

type McpDocument = Record<string, unknown>;

export type IntelProviderStatus = {
  /** True only when `.mcp.json` names a server under {@link INTEL_MCP_SERVER_NAME}. */
  readonly registered: boolean;
  /** Why there is no provider. Empty string when `registered` is true. */
  readonly reason: string;
  readonly serverName: string;
  readonly declaredTools: readonly string[];
  /** Server keys found in the project's `.mcp.json`, for reporting. */
  readonly otherServers: readonly string[];
};

export type IntelRegistrationOutcome =
  | { readonly outcome: "registered" | "updated" | "unchanged"; readonly path: string }
  | { readonly outcome: "refused"; readonly reason: string };

export type IntelServerScope = {
  readonly store: string;
  readonly repository: string;
};

/**
 * The launch spec written into `.mcp.json`.
 *
 * `visp-intel mcp` requires BOTH `--store` and `--repository`; there is no
 * default for either. That is why registration takes an explicit scope rather
 * than guessing one — a server registered against a store that does not exist
 * would fail at connect time, which is a different silence from the one being
 * repaired here.
 */
function intelServerEntry(scope: IntelServerScope): Record<string, unknown> {
  return {
    command: INTEL_MCP_SERVER_NAME,
    args: ["mcp", "--store", scope.store, "--repository", scope.repository]
  };
}

function mcpConfigPath(projectPath: string): string {
  return join(projectPath, MCP_CONFIG_FILENAME);
}

type RegistryRead =
  | { readonly state: "absent" }
  | { readonly state: "unparsable"; readonly reason: string }
  | { readonly state: "present"; readonly document: McpDocument; readonly servers: McpDocument };

async function readRegistry(projectPath: string): Promise<RegistryRead> {
  const text = await readTextIfExists(mcpConfigPath(projectPath));
  if (text === undefined) {
    return { state: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      state: "unparsable",
      reason: `${MCP_CONFIG_FILENAME} could not be parsed as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "unparsable", reason: `${MCP_CONFIG_FILENAME} could not be parsed as a JSON object` };
  }
  const document = parsed as McpDocument;
  const rawServers = document.mcpServers;
  const servers =
    rawServers !== null && typeof rawServers === "object" && !Array.isArray(rawServers)
      ? (rawServers as McpDocument)
      : {};
  return { state: "present", document, servers };
}

/**
 * Answer whether this project has a provider for the scout's declared tools.
 *
 * Deliberately cheap and offline: it inspects registration, not reachability.
 * A registered server that fails to start is the host's report to make; an
 * unregistered one is ours, and it is the one that used to pass unmentioned.
 */
export async function describeIntelProvider(projectPath: string): Promise<IntelProviderStatus> {
  const registry = await readRegistry(projectPath);
  const base = {
    serverName: INTEL_MCP_SERVER_NAME,
    declaredTools: SCOUT_DECLARED_INTEL_TOOLS
  } as const;

  if (registry.state === "absent") {
    return {
      ...base,
      registered: false,
      otherServers: [],
      reason: `this project has no ${MCP_CONFIG_FILENAME}, so nothing provides ${INTEL_MCP_TOOL_PREFIX}* tools`
    };
  }
  if (registry.state === "unparsable") {
    return { ...base, registered: false, otherServers: [], reason: registry.reason };
  }

  const otherServers = Object.keys(registry.servers).sort();
  if (Object.hasOwn(registry.servers, INTEL_MCP_SERVER_NAME)) {
    return { ...base, registered: true, otherServers, reason: "" };
  }
  return {
    ...base,
    registered: false,
    otherServers,
    reason:
      `${MCP_CONFIG_FILENAME} registers ${
        otherServers.length === 0 ? "no servers" : otherServers.join(", ")
      } but not ${INTEL_MCP_SERVER_NAME}, so nothing provides ${INTEL_MCP_TOOL_PREFIX}* tools`
  };
}

/**
 * Can the host actually LAUNCH the server we are about to register?
 *
 * Only a spawn failure answers no. `visp-intel --version` prints its version
 * and exits 2 — a commander quirk — so a probe that demanded exit 0 refused
 * every real installation while accepting the friendly shim in its own tests.
 * The question here is whether the binary exists and is executable; whatever
 * exit code it chooses for a version flag is not our business.
 */
const SPAWN_FAILURE_CODES = new Set(["ENOENT", "EINVAL", "EACCES", "EPERM"]);

async function intelBinaryRuns(projectPath: string): Promise<string | null> {
  try {
    await execFileResolved(INTEL_MCP_SERVER_NAME, ["--version"], {
      cwd: projectPath,
      timeout: BINARY_PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    });
    return null;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (typeof failure.code === "string" && SPAWN_FAILURE_CODES.has(failure.code)) {
      return `the ${INTEL_MCP_SERVER_NAME} binary could not be run (${failure.code}); install it before registering the scout's MCP provider`;
    }
    // It ran. A non-zero exit from a version probe proves exactly what the
    // guard needed to know.
    return null;
  }
}

/**
 * Merge the `visp-intel` server into the project's `.mcp.json`.
 *
 * Merge, never replace: `.mcp.json` is shared with every other MCP server the
 * project uses, and a write that dropped one would trade this silent failure
 * for a louder one somewhere else. A file that will not parse is left exactly
 * as found and reported — guessing at a repair would risk destroying a
 * hand-edited registry.
 */
export async function registerIntelMcpServer(
  projectPath: string,
  options: IntelServerScope & { readonly force?: boolean }
): Promise<IntelRegistrationOutcome> {
  const store = options.store.trim();
  const repository = options.repository.trim();
  if (store.length === 0 || repository.length === 0) {
    return {
      outcome: "refused",
      reason: `${INTEL_MCP_SERVER_NAME} needs both a store path and a repository instance id; neither has a default`
    };
  }
  if (!(await fileExists(store))) {
    return {
      outcome: "refused",
      reason: `the visp-intel store ${store} does not exist; index the repository before registering the server`
    };
  }
  const binaryProblem = await intelBinaryRuns(projectPath);
  if (binaryProblem !== null) {
    return { outcome: "refused", reason: binaryProblem };
  }

  const registry = await readRegistry(projectPath);
  if (registry.state === "unparsable") {
    return { outcome: "refused", reason: `${registry.reason}; it was left unchanged` };
  }

  const entry = intelServerEntry({ store, repository });
  const document: McpDocument = registry.state === "present" ? { ...registry.document } : {};
  const servers: McpDocument = registry.state === "present" ? { ...registry.servers } : {};
  const existing = servers[INTEL_MCP_SERVER_NAME];
  const alreadyCorrect = existing !== undefined && sameEntry(existing, entry);
  if (alreadyCorrect) {
    return { outcome: "unchanged", path: mcpConfigPath(projectPath) };
  }

  servers[INTEL_MCP_SERVER_NAME] = entry;
  document.mcpServers = servers;
  await writeText(mcpConfigPath(projectPath), `${JSON.stringify(document, null, 2)}\n`);
  return {
    outcome: existing === undefined ? "registered" : "updated",
    path: mcpConfigPath(projectPath)
  };
}

function sameEntry(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
