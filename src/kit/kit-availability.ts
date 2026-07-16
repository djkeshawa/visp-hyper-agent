import type { KitStatus } from "./kit-schemas.js";

export type KitAvailabilityReasonCode =
  | "no_kit_signals"
  | "binary_not_found"
  | "status_timeout"
  | "status_nonzero"
  | "status_malformed"
  | "status_uninitialized"
  | "status_failed"
  | "kit_signal_probe_failed"
  | "status_command_failed";

export type KitAvailability =
  | {
      state: "healthy";
      available: true;
      status: KitStatus;
      warnings: string[];
    }
  | {
      state: "absent";
      available: false;
      reasonCode: "no_kit_signals";
      reason: string;
      warnings: string[];
    }
  | {
      state: "configured-unhealthy";
      available: false;
      reasonCode: Exclude<KitAvailabilityReasonCode, "no_kit_signals">;
      reason: string;
      warnings: string[];
    };

export type KitStatusProbeOutcome =
  | {
      kind: "completed";
      exitCode: number;
      status: KitStatus | null;
    }
  | {
      kind: "failed";
      reasonCode:
        | "binary_not_found"
        | "status_timeout"
        | "kit_signal_probe_failed"
        | "status_command_failed";
      reason: string;
    };

/**
 * Pure classification boundary for the three supported Kit availability modes.
 * Command execution and JSON parsing happen outside this function so every
 * caller receives the same deterministic state and reason-code vocabulary.
 */
export function classifyKitAvailability(input: {
  hasKitSignals: boolean;
  probe?: KitStatusProbeOutcome;
}): KitAvailability {
  if (!input.hasKitSignals) {
    return unavailable(
      "absent",
      "no_kit_signals",
      "no Visp Kit-owned project, policy, state, feature, or runtime artifacts were found."
    );
  }

  if (!input.probe) {
    return unavailable(
      "configured-unhealthy",
      "status_command_failed",
      "visp status could not be executed."
    );
  }

  if (input.probe.kind === "failed") {
    return unavailable(
      "configured-unhealthy",
      input.probe.reasonCode,
      input.probe.reason
    );
  }

  // Exit status is authoritative. Never accept healthy-looking JSON emitted by
  // a command that failed.
  if (input.probe.exitCode !== 0) {
    return unavailable(
      "configured-unhealthy",
      "status_nonzero",
      `visp status exited with code ${input.probe.exitCode}.`
    );
  }

  if (!input.probe.status) {
    return unavailable(
      "configured-unhealthy",
      "status_malformed",
      "visp status output could not be parsed as kit status JSON."
    );
  }

  if (!input.probe.status.initialized) {
    return unavailable(
      "configured-unhealthy",
      "status_uninitialized",
      "visp kit is not initialized for this project."
    );
  }

  if (!input.probe.status.success) {
    return unavailable(
      "configured-unhealthy",
      "status_failed",
      "visp status reported success=false."
    );
  }

  return {
    state: "healthy",
    available: true,
    status: input.probe.status,
    warnings: []
  };
}

function unavailable(
  state: "absent" | "configured-unhealthy",
  reasonCode: KitAvailabilityReasonCode,
  reason: string
): KitAvailability {
  if (state === "absent") {
    return {
      state,
      available: false,
      reasonCode: "no_kit_signals",
      reason,
      warnings: [reason]
    };
  }
  if (reasonCode === "no_kit_signals") {
    throw new Error("no_kit_signals is only valid for genuine Kit absence.");
  }
  return {
    state,
    available: false,
    reasonCode,
    reason,
    warnings: [reason]
  };
}

export type KitAuthorityStopInput = {
  status: "BLOCKED" | "INCONCLUSIVE";
  reasonCode: string;
  reason: string;
  failedRules?: Array<{ ruleId: string; message?: string }>;
  nextAllowedCommand?: string;
};

/** Render a stable machine-readable stop result without inventing recovery. */
export function renderKitAuthorityStop(input: KitAuthorityStopInput): string {
  const lines = [
    "BEGIN_VISP_KIT_AUTHORITY_RESULT",
    `status: ${input.status}`,
    `reason_code: ${singleLine(input.reasonCode)}`,
    `reason: ${singleLine(input.reason)}`
  ];

  for (const rule of input.failedRules ?? []) {
    const message = rule.message ? `: ${singleLine(rule.message)}` : "";
    lines.push(`failed_rule: ${singleLine(rule.ruleId)}${message}`);
  }
  if (input.nextAllowedCommand) {
    lines.push(`next_allowed_command: ${singleLine(input.nextAllowedCommand)}`);
  }
  lines.push("END_VISP_KIT_AUTHORITY_RESULT");
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
