import { describe, expect, it } from "vitest";
import { workflowActionCheckRecovery } from "../../../../../src/cli/commands/doctor/kit-checks.js";

describe("the remedy doctor prints for a failed WorkflowAction check", () => {
  it("does not send the reader to re-link the pair when Kit simply ran out of time", () => {
    // LC-27. A timeout says nothing about the pair, and re-linking Kit and
    // Hyper is the expensive thing to go and check.
    const recovery = workflowActionCheckRecovery("kit_command_timeout");

    expect(recovery).toMatch(/did not answer within its budget/i);
    expect(recovery).not.toMatch(/link a kit\/hyper pair/i);
  });

  it("still sends the reader to the pair when Kit answered something unusable", () => {
    for (const reasonCode of [
      "unsupported_integration_contract",
      "unsupported_workflow_action",
      "strict_next_unavailable",
      "integration_contract_unavailable"
    ] as const) {
      expect(workflowActionCheckRecovery(reasonCode)).toMatch(/link a kit\/hyper pair/i);
    }
  });
});
