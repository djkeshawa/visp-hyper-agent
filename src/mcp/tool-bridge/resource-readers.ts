/**
 * Producing the body of a resource read.
 *
 * The computed resources live here: the surface manifest that describes this
 * server, the canonical action negotiated with Kit, and the Kit read contract.
 * Each answers with a definite state — a degraded read reports why rather than
 * returning nothing.
 */

import { readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { checkContextFreshness } from "../../context/context-freshness.js";
import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import { readScoutFindings } from "../../scout/scout-findings.js";
import { toHyperActionEnvelope } from "../../kit/workflow-action-renderer.js";
import type { McpResourceContent } from "../mcp-server.js";
import { hashStable } from "../../core/stable-hash.js";
import { SERVER_VERSION, toolDefs } from "./tool-specs.js";
import { PROMPTS } from "./prompts.js";
import { CANONICAL_ACTION_RESOURCE, CONTEXT_FRESHNESS_RESOURCE, KIT_READ_CONTRACT_RESOURCE, RESOURCE_SPECS, SCOUT_FINDINGS_RESOURCE, SURFACE_MANIFEST_RESOURCE } from "./resource-specs.js";
import type { CanonicalActionResourceV1 } from "./resource-specs.js";

export async function readResource(projectPath: string, uri: string): Promise<McpResourceContent | null> {
  if (uri === SURFACE_MANIFEST_RESOURCE.uri) {
    return {
      uri,
      mimeType: SURFACE_MANIFEST_RESOURCE.mimeType,
      text: `${JSON.stringify(buildSurfaceManifest(), null, 2)}\n`
    };
  }

  if (uri === CONTEXT_FRESHNESS_RESOURCE.uri) {
    const freshness = await checkContextFreshness(projectPath);
    return {
      uri,
      mimeType: CONTEXT_FRESHNESS_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt: new Date().toISOString(),
          ...freshness
        },
        null,
        2
      )}\n`
    };
  }

  if (uri === KIT_READ_CONTRACT_RESOURCE.uri) {
    return readKitReadContractResource(projectPath, uri);
  }

  if (uri === SCOUT_FINDINGS_RESOURCE.uri) {
    const report = await readScoutFindings(projectPath);
    return {
      uri,
      mimeType: SCOUT_FINDINGS_RESOURCE.mimeType,
      text: `${JSON.stringify({ resourceVersion: "1.0", authority: "none", ...report }, null, 2)}\n`
    };
  }

  if (uri === CANONICAL_ACTION_RESOURCE.uri) {
    const body = await readCanonicalActionResource(projectPath);
    return {
      uri,
      mimeType: CANONICAL_ACTION_RESOURCE.mimeType,
      text: `${JSON.stringify(body, null, 2)}\n`
    };
  }

  const spec = RESOURCE_SPECS.find((candidate) => candidate.uri === uri);
  if (!spec) {
    return null;
  }
  const text = await readTextIfExists(vispPath(projectPath, ...spec.path));
  if (text === undefined) {
    return null;
  }
  return {
    uri: spec.uri,
    mimeType: spec.mimeType,
    text
  };
}

export function buildSurfaceManifest(): object {
  const surface = {
    protocolVersion: "2025-06-18",
    serverInfo: { name: "visp-hyper", version: SERVER_VERSION },
    capabilities: {
      tools: true,
      resources: true,
      prompts: true,
      sampling: false,
      elicitation: false,
      dynamicToolRegistration: false
    },
    tools: toolDefs().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchemaHash: hashStable(tool.inputSchema),
      outputSchemaHash: tool.outputSchema ? hashStable(tool.outputSchema) : undefined
    })),
    resources: [
      SURFACE_MANIFEST_RESOURCE,
      {
        ...CONTEXT_FRESHNESS_RESOURCE,
        computed: true
      },
      {
        ...KIT_READ_CONTRACT_RESOURCE,
        computed: true
      },
      {
        ...CANONICAL_ACTION_RESOURCE,
        computed: true
      },
      {
        ...SCOUT_FINDINGS_RESOURCE,
        computed: true
      },
      ...RESOURCE_SPECS.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        mimeType: resource.mimeType,
        description: resource.description,
        projectLocalPath: `.visp/${resource.path.join("/")}`
      }))
    ],
    prompts: PROMPTS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments ?? []
    })),
    safetyPosture: {
      noLlmCalls: true,
      projectLocal: true,
      fixedToolTable: true,
      fixedResourceTable: true,
      fixedPromptTable: true,
      commandExecution: "MCP tools map to fixed local visp-hyper subcommands with typed argument validation.",
      structuredToolResults: "Each MCP tool advertises an outputSchema and returns structuredContent alongside the human-readable block.",
      networkPolicy: "No network calls from the MCP bridge; invoked commands may only contact a configured local llm-memory endpoint when memoryMode is enabled."
    }
  };
  return {
    version: "0.1",
    generatedAt: new Date().toISOString(),
    surfaceHashAlgorithm: "sha256",
    surfaceHash: hashStable(surface),
    ...surface
  };
}

export async function readCanonicalActionResource(
  projectPath: string
): Promise<CanonicalActionResourceV1> {
  const availability = await detectVisp(projectPath);
  if (availability.state === "absent") {
    return {
      resourceVersion: "1.0",
      availability: "unavailable",
      authority: "none",
      reasonCode: "no_kit_signals",
      reason: singleLineReason(availability.reason)
    };
  }
  if (availability.state === "configured-unhealthy") {
    return inconclusiveCanonicalAction(availability.reasonCode, availability.reason);
  }

  const bridge = new KitCommandBridge({ projectPath });
  const contractDiagnostic = await bridge.integrationContractDiagnostic();
  if (!contractDiagnostic.ok) {
    return inconclusiveCanonicalAction(
      contractDiagnostic.reasonCode,
      contractDiagnostic.reason
    );
  }

  const actionDiagnostic = await bridge.nextCanonicalActionDiagnostic(
    "auto",
    contractDiagnostic.value
  );
  if (!actionDiagnostic.ok) {
    return inconclusiveCanonicalAction(
      actionDiagnostic.reasonCode,
      actionDiagnostic.reason
    );
  }

  return {
    resourceVersion: "1.0",
    availability: "available",
    envelope: toHyperActionEnvelope(actionDiagnostic.value)
  };
}

export function inconclusiveCanonicalAction(
  reasonCode: string,
  reason: string
): CanonicalActionResourceV1 {
  return {
    resourceVersion: "1.0",
    availability: "inconclusive",
    authority: "kit",
    reasonCode,
    reason: singleLineReason(reason)
  };
}

export function singleLineReason(reason: string): string {
  return reason.replace(/[\r\n]+/gu, " ").trim();
}

export async function readKitReadContractResource(projectPath: string, uri: string): Promise<McpResourceContent> {
  const generatedAt = new Date().toISOString();
  const manifestText = await readTextIfExists(vispPath(projectPath, "hyper", "current", "context-manifest.json"));
  if (!manifestText) {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "unavailable",
          reason: "context manifest is missing; run `visp work \"<goal>\"` to create the active handoff"
        },
        null,
        2
      )}\n`
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "error",
          reason: "context manifest is unreadable; regenerate with `visp work \"<goal>\"`"
        },
        null,
        2
      )}\n`
    };
  }

  const kitReadContract = manifest && typeof manifest === "object"
    ? (manifest as Record<string, unknown>).kitReadContract
    : undefined;
  if (!kitReadContract || typeof kitReadContract !== "object") {
    return {
      uri,
      mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
      text: `${JSON.stringify(
        {
          version: "0.1",
          generatedAt,
          status: "unavailable",
          reason: "active context manifest has no Kit read contract; rerun with a Visp Kit that advertises integration contract 1.3"
        },
        null,
        2
      )}\n`
    };
  }

  return {
    uri,
    mimeType: KIT_READ_CONTRACT_RESOURCE.mimeType,
    text: `${JSON.stringify(
      {
        version: "0.1",
        generatedAt,
        ...kitReadContract,
        status: "available"
      },
      null,
      2
    )}\n`
  };
}
