import type { KitIntegrationContract } from "./kit-schemas.js";

const PROVENANCE_FRESHNESS_CONTRACT = "2.0";
export const SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION = "2.0";
export const SUPPORTED_WORKFLOW_ACTION_VERSION = "2.0";

export function unsupportedIntegrationContractWarning(payload: unknown): string | undefined {
  const version = stringProperty(payload, "contractVersion");
  if (version === undefined || version === SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION) {
    return undefined;
  }
  return `Unsupported Kit integration contract version ${version}; expected ${SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION}.`;
}

export function unsupportedWorkflowActionWarning(payload: unknown): string | undefined {
  const version = stringProperty(payload, "protocolVersion");
  if (version === undefined || version === SUPPORTED_WORKFLOW_ACTION_VERSION) {
    return undefined;
  }
  return `Unsupported Kit workflow action protocol version ${version}; expected ${SUPPORTED_WORKFLOW_ACTION_VERSION}.`;
}

export function provenanceFreshnessContractWarning(
  contract: KitIntegrationContract
): string | undefined {
  const missing: string[] = [];

  if (contract.capabilities?.contextGrounding?.artifactProvenance !== true) {
    missing.push("contextGrounding.artifactProvenance");
  }
  if (!contract.workflow?.freshnessChecks?.includes("contextPack.artifactProvenance[]")) {
    missing.push("workflow.freshnessChecks includes contextPack.artifactProvenance[]");
  }

  if (missing.length === 0) {
    return undefined;
  }

  return `Kit integration contract ${contract.contractVersion} does not advertise provenance freshness (${missing.join(", ")}); upgrade or link a Visp Kit that supports contract ${PROVENANCE_FRESHNESS_CONTRACT}.`;
}

function stringProperty(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
