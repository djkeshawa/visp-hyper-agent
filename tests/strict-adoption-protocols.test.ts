import { describe, expect, it } from "vitest";

import {
  supportsStrictSessionAdoption,
  WORKFLOW_ACTION_PROTOCOL_PREFERENCE
} from "../src/kit/workflow-action-protocol.js";

describe("strict session adoption follows the protocol preference list", () => {
  // `visp work` hardcoded "3.0"/"3.1"/"3.2" at its call site. When negotiation
  // moved to 3.4, every other consumer followed the preference list and kept
  // working; work alone refused strict adoption in every project, and the
  // composites' own advice — "implementation is allowed, run visp work" —
  // became a dead end. This test is deliberately written over the preference
  // list itself so a future 3.5 cannot repeat the drift: add the protocol to
  // the list and adoption support follows, or this fails and forces the call.
  it("adopts every 3.x protocol Hyper is willing to negotiate", () => {
    for (const protocol of WORKFLOW_ACTION_PROTOCOL_PREFERENCE) {
      expect(supportsStrictSessionAdoption(protocol)).toBe(protocol !== "2.0");
    }
  });

  it("still refuses 2.0, which predates explicit phase and task identity", () => {
    expect(supportsStrictSessionAdoption("2.0")).toBe(false);
  });
});
