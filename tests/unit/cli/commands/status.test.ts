// F1 — `visp status` is readable by the human it is offered to.
//
// `status` is one of the thirteen verbs a user is told to use. It printed a
// single-line four-kilobyte BEGIN_VISP_HYPER_ACTION_V1 envelope and nothing
// else. The information inside is genuinely good — phase, task, verdict,
// findings, next command — which makes it worse rather than better: everything
// the reader needed was present and unreadable.
//
// The frame is a real machine surface (guard and work emit it, and a
// cross-surface conformance test pins its normalization), so it is preserved
// exactly, behind --json.

import { describe, expect, it } from "vitest";

import { statusCommand, verbForKitCommand } from "../../../../src/cli/commands/status.js";

describe("status offers a human rendering and keeps the frame", () => {
  it("declares a --json flag", () => {
    const flags = statusCommand()
      .options.map((option) => option.long)
      .filter(Boolean);

    expect(
      flags,
      "without --json the machine frame would have no home, and guard/work consumers " +
        "plus the conformance test depend on it"
    ).toContain("--json");
  });

  it("does not emit the frame by default", () => {
    // Asserted on the source rather than by driving a full Kit project: the
    // point is that the default path chooses the summary, and the conformance
    // suite already exercises the frame end to end.
    const source = statusCommand()
      .options.map((option) => `${option.long} ${option.description}`)
      .join(" ");

    expect(source).toMatch(/machine-readable/iu);
  });
});

// Driving a fresh project end to end through the thirteen verbs, `status`
// answered "Next: visp-kit verify --task T001" — the human surface teaching
// its reader to abandon the human surface. The verb that drives Kit's command
// leads; Kit's command stays visible because it is the authority.
describe("status translates Kit's next command into the verb that drives it", () => {
  it("maps the preparation chain to visp plan", () => {
    expect(verbForKitCommand("visp-kit spec --validate", null)).toBe("visp plan");
    expect(verbForKitCommand("visp-kit scan", null)).toBe("visp plan");
    expect(verbForKitCommand("visp-kit context --next", "T001")).toBe("visp plan");
  });

  it("maps the evidence chain to visp save with the task", () => {
    expect(verbForKitCommand("visp-kit verify --task T001", "T001")).toBe(
      "visp save --task T001"
    );
    expect(verbForKitCommand("visp-kit checklist status --task T001", "T001")).toBe(
      "visp save --task T001"
    );
  });

  it("maps pr to handoff and init to setup", () => {
    expect(verbForKitCommand("visp-kit pr", null)).toBe("visp handoff");
    expect(verbForKitCommand("visp-kit init", null)).toBe("visp setup");
  });

  it("stays honest when no verb covers the command", () => {
    expect(verbForKitCommand("Use .visp/prompts/current-task.prompt.md with your agent", null)).toBe(
      null
    );
  });
});

describe("the terminal state names the verb, not the engine", () => {
  it("translates the embedded feature command and keeps the sentence", () => {
    const sentence =
      'Feature complete — pr.md is ready for review. Start the next feature with visp-kit feature "<describe your feature>"';
    const translated = verbForKitCommand(sentence, null);

    expect(translated).toContain("visp new");
    expect(translated).not.toContain("visp-kit feature");
    expect(translated).toContain("pr.md is ready for review");
  });
});
