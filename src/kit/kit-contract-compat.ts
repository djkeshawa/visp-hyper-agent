import type { KitIntegrationContract } from "./kit-schemas.js";

const PROVENANCE_FRESHNESS_CONTRACT = "1.2";

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
