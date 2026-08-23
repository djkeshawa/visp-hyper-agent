/**
 * Checks that drive the installed Visp Kit: its CLI, its integration contract,
 * the negotiated WorkflowAction protocol, policy validation, the next gate, and
 * the active task's context pack.
 *
 * These append to a shared list rather than returning one record, because a
 * single Kit probe can produce several findings plus the warnings drained from
 * the bridge along the way.
 */

import { readTextIfExists, vispPath } from "../../../core/fs-utils.js";
import { provenanceFreshnessContractWarning } from "../../../kit/kit-contract-compat.js";
import { PINNED_PAIR_GUIDANCE } from "../../../kit/workflow-action-protocol.js";
import { KitCommandBridge, detectVisp } from "../../../kit/kit-command-bridge.js";
import type { KitBridgeDiagnosticReasonCode } from "../../../kit/kit-command-bridge.js";
import type { KitIntegrationContract } from "../../../kit/kit-schemas.js";
import { contextPackPathIfExists } from "../shared.js";
import { activeHandoffExists } from "./active-handoff.js";
import type { DoctorCheck } from "./types.js";

export async function checkKitBackend(projectPath: string, checks: DoctorCheck[]): Promise<void> {
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

  // A health check must not pass while the canonical status command is
  // reporting a corrupted core artifact on the same project. Doctor answered
  // "Overall: PASS" at the exact moment `visp status` said "spec is
  // unreadable: Invalid JSON…" — the one tool whose job is to notice.
  const corrupted = (availability.status.warnings ?? []).filter((warning) =>
    warning.includes("is unreadable:")
  );
  checks.push(
    corrupted.length > 0
      ? {
          id: "kit-binary",
          label: "Visp Kit CLI",
          status: "fail",
          detail: `visp-kit reports a corrupted artifact: ${corrupted[0]}`,
          recovery: "Repair or restore the named file by hand; regenerating would overwrite it."
        }
      : {
          id: "kit-binary",
          label: "Visp Kit CLI",
          status: "pass",
          detail: `Parsed visp status for ${featureLabel(availability.status.activeFeature) ?? "the project"}.`
        }
  );
  addWarnings(checks, availability.warnings, "kit-detect-warning");

  const bridge = new KitCommandBridge({ projectPath });

  const contract = await bridge.integrationContract();
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-contract-warning");
  if (contract === null) {
    checks.push({
      id: "kit-contract",
      label: "Kit integration contract",
      status: "warn",
      detail: "visp-kit integration contract could not be read; falling back to legacy status and artifact probing.",
      recovery: `This Kit does not answer \`visp-kit integration contract --json\`. ${PINNED_PAIR_GUIDANCE}`
    });
    checks.push({
      id: "kit-workflow-action",
      label: "Kit WorkflowAction protocol",
      status: "fail",
      detail: "integration_contract_unavailable: no supported Kit contract is available for WorkflowAction negotiation.",
      recovery: `${PINNED_PAIR_GUIDANCE} Then re-run \`visp doctor\`.`
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
        ? `This pair does not advertise provenance freshness, so context cannot be grounded on artifact provenance. ${PINNED_PAIR_GUIDANCE}`
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
        recovery: workflowActionCheckRecovery(action.reasonCode)
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
          // A null result can mean a timeout, a non-zero exit, a missing binary, or a
          // genuine parse failure. Naming only the last one sent people to fix output
          // that was never produced. The real reason is in the warning drained above.
          detail: "visp-kit policy validate did not return a usable result; see the warning above for why.",
          recovery: "Run `visp-kit policy validate --json` and check whether it completes, exits non-zero, or emits unexpected output."
        }
      : {
          id: "kit-policy",
          label: "Policy validation",
          status: policy.success ? "pass" : "fail",
          detail: policy.success
            ? "Policy validates successfully."
            : `Policy validation failed: ${policy.errors.join("; ") || "no error detail reported"}.`,
          recovery: policy.success ? undefined : "Fix .visp/policy.json, then re-run `visp-kit policy validate`."
        }
  );

  const gate = await bridge.gate("next");
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-gate-warning");
  if (gate === null) {
    checks.push({
      id: "kit-next-gate",
      label: "Next gate",
      status: "fail",
      detail: "visp-kit gate next did not return a usable result; see the warning above for why.",
      recovery: "Run `visp-kit gate next --json` and check whether it completes, exits non-zero, or emits unexpected output."
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
    recovery: pack ? undefined : `Run \`visp-kit context --task ${activeTaskId}\`, then re-run \`visp doctor\`.`
  });
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

  const recovery = "Regenerate the active handoff with `visp work \"<goal>\"`.";
  const manifestPath = vispPath(projectPath, "hyper", "current", "context-manifest.json");
  const manifestText = await readTextIfExists(manifestPath);

  // A project that has never been handed off carries no read contract because
  // there is nothing to carry one, which is not the same as a handoff that
  // lost it. See `./active-handoff.ts` — this finding is verdict-bearing.
  if (!manifestText && !(await activeHandoffExists(projectPath))) {
    return {
      id: "kit-read-contract",
      label: "Active Kit read contract",
      status: "pass",
      detail:
        `Kit advertises orchestrator read contracts (${contract.orchestrator?.readContractVersion}), ` +
        "and this project has no handoff yet for one to be carried in."
    };
  }

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

/**
 * What to tell someone whose WorkflowAction check failed.
 *
 * A Kit that never answered inside its budget told `doctor` nothing about the
 * pair, so sending the reader off to re-link Kit and Hyper is advice for a
 * problem that has not been shown to exist — and the pair is the expensive
 * thing to go and check. LC-27.
 */
export function workflowActionCheckRecovery(reasonCode: KitBridgeDiagnosticReasonCode): string {
  if (reasonCode === "kit_command_timeout") {
    return (
      "Kit did not answer within its budget, so nothing here is known about the pair. " +
      "Re-run on a less busy machine; if it repeats, run the Kit command directly to see where it stalls."
    );
  }
  return "Link a Kit/Hyper pair with matching WorkflowAction advertisement, schema, and action identity.";
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

function featureLabel(feature: { id: string; slug?: string } | null | undefined): string | undefined {
  if (!feature) {
    return undefined;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}
