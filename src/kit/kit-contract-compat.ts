import type { KitIntegrationContract } from "./kit-schemas.js";
import { PINNED_PAIR_GUIDANCE } from "./workflow-action-protocol.js";

const PROVENANCE_FRESHNESS_CONTRACT = "2.0";
export const SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION = "2.0";

export function unsupportedIntegrationContractWarning(payload: unknown): string | undefined {
  const version = stringProperty(payload, "contractVersion");
  if (version === undefined || version === SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION) {
    return undefined;
  }
  return `Unsupported Kit integration contract version ${version}; expected ${SUPPORTED_KIT_INTEGRATION_CONTRACT_VERSION}. ${PINNED_PAIR_GUIDANCE}`;
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

  // Deliberately not "upgrade Kit": the pair, not the version, is the unit of
  // compatibility, and the reader needs the pinned check rather than a bump.
  return `Kit integration contract ${contract.contractVersion} does not advertise provenance freshness (${missing.join(", ")}); this pair cannot ground context on artifact provenance, which contract ${PROVENANCE_FRESHNESS_CONTRACT} advertises. ${PINNED_PAIR_GUIDANCE}`;
}

function stringProperty(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
