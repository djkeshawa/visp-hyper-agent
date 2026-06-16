import { z } from "zod";
import type { HyperConfig, SemanticMemoryProvider } from "../core/types.js";
import { LlmMemoryProvider } from "./llm-memory-provider.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 1500;

const healthSchema = z
  .object({
    status: z.string()
  })
  .passthrough();

export type MemoryProviderSelection = {
  provider: SemanticMemoryProvider | null;
  mode: "file" | "llm-memory";
  warnings: string[];
};

/**
 * Choose the memory provider for a session. File mode yields a null provider
 * (the existing file flow handles persistence). llm-memory mode probes the
 * server's health endpoint and falls back to file memory if it is unreachable.
 */
export async function selectMemoryProvider(input: {
  config: HyperConfig;
  projectPath: string;
  timeoutMs?: number;
}): Promise<MemoryProviderSelection> {
  if (input.config.memoryMode === "file") {
    return { provider: null, mode: "file", warnings: [] };
  }

  const endpoint = (input.config.memoryEndpoint || "http://localhost:8000").replace(/\/+$/u, "");

  // init validates the endpoint, but config.json can be hand-edited; re-check
  // the scheme before we ever fetch it so a bad value degrades to file memory
  // rather than throwing or reaching an unexpected host.
  const endpointError = httpEndpointError(endpoint);
  if (endpointError) {
    return {
      provider: null,
      mode: "file",
      warnings: [`llm-memory endpoint ${endpoint} is invalid: ${endpointError}; falling back to file memory`]
    };
  }

  const timeout = input.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const probe = await probeHealth(endpoint, timeout);
  if (!probe.ok) {
    return {
      provider: null,
      mode: "file",
      warnings: [`llm-memory unavailable at ${endpoint}: ${probe.reason}; falling back to file memory`]
    };
  }

  const provider = new LlmMemoryProvider({
    endpoint,
    projectPath: input.projectPath,
    repoId: input.config.memoryRepoId,
    timeoutMs: input.timeoutMs
  });
  return { provider, mode: "llm-memory", warnings: [] };
}

function httpEndpointError(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `unsupported protocol "${url.protocol}"`;
  }
  return null;
}

async function probeHealth(
  endpoint: string,
  timeoutMs: number
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let response: Response;
  try {
    response = await fetch(`${endpoint}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { ok: false, reason: `health check returned ${response.status}` };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: "health response was not valid JSON" };
  }
  const parsed = healthSchema.safeParse(data);
  if (!parsed.success || parsed.data.status !== "ok") {
    return { ok: false, reason: "health status was not ok" };
  }
  return { ok: true };
}
