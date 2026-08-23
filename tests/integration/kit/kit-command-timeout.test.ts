import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  KIT_DEFAULT_TIMEOUT_MS,
  KIT_NO_SPAWN_DEADLINE_MS,
  KitCommandBridge
} from "../../../src/kit/kit-command-bridge.js";
import {
  canonicalKitSpec,
  integrationContractFixture,
  workflowActionV3Fixture
} from "../../helpers/canonical-action-fixture.js";
import { createVispShim, policyValidateFixture } from "../../helpers/visp-shim.js";

/**
 * LC-27. A Kit that never answered inside its budget and a Kit that answered
 * something the contract forbids used to arrive at the caller identically: a
 * `null`, or a diagnostic saying no supported contract was available. One of
 * those is a busy machine and the other is a defect in the pair, and the flake
 * this ticket came from was misread as the second because it presented as the
 * second.
 *
 * The shim spawns a real child process and answers late, so the timeout being
 * measured is a genuine spawn timeout rather than a stubbed one. Budgets here
 * are deliberately tiny — the point is which diagnosis comes back, not how long
 * anything waits.
 */
const SHIM_DELAY_MS = 250;
const IMPATIENT_BUDGET_MS = 20;

const MISSING_BINARY = join(tmpdir(), "visp-binary-that-is-not-there-lc27");

function bridgeFor(binary: string, timeoutMs?: number): KitCommandBridge {
  return new KitCommandBridge({ projectPath: process.cwd(), binary, timeoutMs });
}

describe("a Kit command that runs out of time", () => {
  it("names the timeout instead of reporting an unavailable integration contract", async () => {
    const shim = await createVispShim(
      canonicalKitSpec({
        extra: { integration: { stdout: integrationContractFixture(), delayMs: SHIM_DELAY_MS } }
      })
    );
    const bridge = bridgeFor(shim.binary, IMPATIENT_BUDGET_MS);

    const diagnostic = await bridge.integrationContractDiagnostic();

    expect(diagnostic.ok).toBe(false);
    if (diagnostic.ok) return;
    expect(diagnostic.reasonCode).toBe("kit_command_timeout");
    expect(diagnostic.reason).toMatch(/timed out/i);
  });

  it("names the timeout instead of reporting an unavailable strict next action", async () => {
    // The contract answers promptly and only `next` is slow, so nothing about
    // the negotiated protocol is in doubt — exactly the shape that used to come
    // back as `strict_next_unavailable` and send the reader to the contract.
    const shim = await createVispShim(
      canonicalKitSpec({
        extra: { next: { stdout: workflowActionV3Fixture(), delayMs: SHIM_DELAY_MS } }
      })
    );
    const bridge = bridgeFor(shim.binary, IMPATIENT_BUDGET_MS);

    const diagnostic = await bridge.nextCanonicalActionDiagnostic("auto");

    expect(diagnostic.ok).toBe(false);
    if (diagnostic.ok) return;
    expect(diagnostic.reasonCode).toBe("kit_command_timeout");
    expect(diagnostic.reason).toMatch(/timed out/i);
  });

  it("records itself on a bridge method whose only failure answer is null", async () => {
    // policyValidate returns KitPolicyValidationResult | null and cannot carry a
    // reason code. The recorded failure is how a caller tells "Kit said nothing"
    // from "Kit said something wrong".
    const shim = await createVispShim({
      policy: { stdout: policyValidateFixture(), delayMs: SHIM_DELAY_MS }
    });
    const bridge = bridgeFor(shim.binary, IMPATIENT_BUDGET_MS);

    expect(await bridge.policyValidate()).toBeNull();
    expect(bridge.lastCommandFailure).toMatchObject({
      command: "visp policy validate",
      reasonCode: "command_timeout",
      timeoutMs: IMPATIENT_BUDGET_MS
    });
  });

  it("stays distinct from a Kit that could not be spawned at all", async () => {
    const bridge = bridgeFor(MISSING_BINARY);

    const diagnostic = await bridge.integrationContractDiagnostic();

    expect(diagnostic.ok).toBe(false);
    if (diagnostic.ok) return;
    expect(diagnostic.reasonCode).toBe("integration_contract_unavailable");
    expect(bridge.lastCommandFailure?.reasonCode).toBe("binary_not_found");
  });

  it("is not recorded at all for a Kit that ran and answered badly", async () => {
    // The recorded failure means "Kit did not run", never "Kit did not work".
    // Filing a bad answer under it would recreate the confusion from the other
    // side: a genuine contract breach excused as a machine problem.
    const shim = await createVispShim({ policy: { stdout: "not json at all" } });
    const bridge = bridgeFor(shim.binary, KIT_NO_SPAWN_DEADLINE_MS);

    expect(await bridge.policyValidate()).toBeNull();
    expect(bridge.lastCommandFailure).toBeUndefined();
    expect(bridge.warnings.join(" ")).toMatch(/did not match the expected schema/i);
  });
});

describe("the deadline a Kit spawn is given", () => {
  it("stays at the default for a caller that did not ask otherwise", async () => {
    // LC-27 moved no threshold and this is what says so. The 10s default is
    // what `guard` needs on the PreToolUse hook, where a hung Kit must surface
    // before it stalls an edit; a test's convenience is never a reason to slow
    // that down for every consumer.
    const bridge = bridgeFor(MISSING_BINARY);

    expect(await bridge.status()).toBeNull();
    expect(bridge.lastCommandFailure?.timeoutMs).toBe(KIT_DEFAULT_TIMEOUT_MS);
  });

  it("arms none at all when the caller takes the clock", async () => {
    // Node reads a timeout of 0 as "do not arm one". Same shim and same delay
    // for both bridges — only the deadline differs — so this is the absence of
    // a budget rather than a larger one.
    expect(KIT_NO_SPAWN_DEADLINE_MS).toBe(0);
    const shim = await createVispShim({
      policy: { stdout: policyValidateFixture(), delayMs: SHIM_DELAY_MS }
    });

    const impatient = bridgeFor(shim.binary, IMPATIENT_BUDGET_MS);
    expect(await impatient.policyValidate()).toBeNull();
    expect(impatient.lastCommandFailure?.reasonCode).toBe("command_timeout");

    const unhurried = bridgeFor(shim.binary, KIT_NO_SPAWN_DEADLINE_MS);
    expect(await unhurried.policyValidate()).not.toBeNull();
    expect(unhurried.lastCommandFailure).toBeUndefined();
  });
});
