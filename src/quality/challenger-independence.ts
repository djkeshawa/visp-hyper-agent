/**
 * Make an `independent_challenger` claim mean what it says (P8-06).
 *
 * Kit already classifies evidence independence — `pre_existing`,
 * `pre_approved`, `implementer_authored`, `independent_challenger`,
 * `human_attestation` — which is the research's core distinction, enforced in a
 * schema. What was missing is anything checking that a result *labelled*
 * `independent_challenger` actually came from an independent source. Hyper's
 * tiers are cost tiers: scout and implementer can be the same model family, and
 * same-family review shares the same blind spots, so a critic that is really the
 * implementer wearing a different label produces agreement rather than evidence.
 *
 * **Scope, and what was deliberately not built.** P8-06 is gated: backlog rule
 * 16 keeps challenger and multi-agent features optional until paired evaluation
 * shows enough decision value to justify their cost and failure surface. That
 * evaluation has not run — P6-11 revised the protocol but no study has executed,
 * and P8-02 built the calibration measurement but no real telemetry exists to
 * measure. So the challenger *capability* is not expanded here.
 *
 * This module is the other half: a constraint on the claim. It can only ever
 * downgrade a result to `inconclusive`; it can never let one pass that would
 * otherwise fail. Adding it does not widen what the system can do, so the gate
 * does not apply to it — and invariant 4 requires it regardless: an unavailable
 * independent lane reports `inconclusive`, never a silent pass.
 */

export type IndependenceClaim =
  | "pre_existing"
  | "pre_approved"
  | "implementer_authored"
  | "independent_challenger"
  | "human_attestation";

export type ModelIdentity = {
  /** Provider or family, e.g. the vendor. Blank or unknown is not a match. */
  readonly modelId: string;
  readonly modelVersion: string | null;
};

export type IndependenceVerdict = {
  /** Whether the claim of independence is supported. */
  readonly independent: boolean;
  /**
   * What the evidence outcome must be capped at. `null` means the claim holds
   * and the outcome is left alone.
   */
  readonly forcedOutcome: "inconclusive" | null;
  readonly reason: string;
};

/**
 * Identities that name a tier rather than a model. A tier is not an identity:
 * "scout" and "implementer" can both resolve to the same underlying model, so
 * treating them as distinct would certify independence that does not exist.
 */
const TIER_PLACEHOLDERS = new Set(["", "unknown", "unreported", "scout", "implementer", "coordinator"]);

function isUsableIdentity(identity: ModelIdentity | null | undefined): identity is ModelIdentity {
  if (!identity) return false;
  const id = identity.modelId.trim().toLowerCase();
  return id.length > 0 && !TIER_PLACEHOLDERS.has(id);
}

function sameModel(a: ModelIdentity, b: ModelIdentity): boolean {
  return (
    a.modelId.trim().toLowerCase() === b.modelId.trim().toLowerCase() &&
    (a.modelVersion ?? "").trim().toLowerCase() === (b.modelVersion ?? "").trim().toLowerCase()
  );
}

/**
 * Judge whether a claimed independence class is supported by the identities
 * that produced the work and the review.
 *
 * Fails closed in every direction where the answer is not knowable: an unknown
 * identity on either side cannot demonstrate independence, so the claim is
 * downgraded rather than assumed. That costs a verdict that might have been
 * legitimate. The alternative is certifying independence nobody established,
 * which is the failure the whole independence taxonomy exists to prevent.
 */
export function judgeChallengerIndependence(input: {
  readonly claim: IndependenceClaim;
  readonly implementer?: ModelIdentity | null;
  readonly challenger?: ModelIdentity | null;
}): IndependenceVerdict {
  // Only the challenger claim asserts model-level independence. The others
  // derive their standing from something else — a pre-existing test, a human —
  // and this constraint has nothing to say about them.
  if (input.claim !== "independent_challenger") {
    return {
      independent: true,
      forcedOutcome: null,
      reason: `${input.claim} does not assert model independence; unaffected`
    };
  }

  if (!isUsableIdentity(input.implementer) || !isUsableIdentity(input.challenger)) {
    return {
      independent: false,
      forcedOutcome: "inconclusive",
      reason:
        "independence cannot be shown: a tier name or missing model identity does not distinguish " +
        "the challenger from the implementer"
    };
  }

  if (sameModel(input.implementer, input.challenger)) {
    return {
      independent: false,
      forcedOutcome: "inconclusive",
      reason:
        `challenger and implementer are the same model (${input.challenger.modelId}` +
        `${input.challenger.modelVersion ? ` ${input.challenger.modelVersion}` : ""}); ` +
        "a review sharing the generator's blind spots is agreement, not evidence"
    };
  }

  return {
    independent: true,
    forcedOutcome: null,
    reason: `challenger ${input.challenger.modelId} differs from implementer ${input.implementer.modelId}`
  };
}

/**
 * Apply the verdict to an evidence outcome.
 *
 * Strictly a downgrade. A failing result stays failing; a passing result whose
 * independence cannot be shown becomes `inconclusive`. Nothing here can turn a
 * failure into a pass, which is why adding it does not expand the challenger
 * capability the P8-06 gate holds back.
 */
export function applyIndependenceVerdict(
  outcome: "passed" | "failed" | "inconclusive",
  verdict: IndependenceVerdict
): "passed" | "failed" | "inconclusive" {
  if (verdict.forcedOutcome === null) return outcome;
  if (outcome === "failed") return "failed";
  return verdict.forcedOutcome;
}
