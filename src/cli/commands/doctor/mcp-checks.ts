/**
 * The MCP surface check: start the server, list what it advertises, and hold
 * the live listing against the manifest it published — including the schema
 * hashes, which is why this file and the tool bridge must hash identically.
 */

import { packageVersion } from "../../../core/package-version.js";
import { handleMessage } from "../../../mcp/mcp-server.js";
import { createToolContext } from "../../../mcp/tool-bridge.js";
import { isSha256 } from "../../../core/guards.js";
import { hashStable } from "../../../core/stable-hash.js";
import type { DoctorCheck } from "./types.js";

export async function checkMcp(projectPath: string): Promise<DoctorCheck> {
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
