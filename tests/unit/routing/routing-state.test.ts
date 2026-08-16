// The routing store's read-side migration.
//
// `routing.json` is written by older Hyper versions as well as this one, and the
// preprocess step in front of the schema is what lets an old file keep meaning
// something. Two shapes moved: `taskClass` used to hold a RISK LEVEL, and
// quarantines used to be appended rather than keyed by class.
//
// A migration is only worth having if a file it cannot understand is DROPPED
// rather than smuggled through, so both halves are asserted here: what survives
// and what is refused.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readRoutingState,
  recordRoutingDecision,
  routingStateSchema,
  writeRoutingState,
  type RoutingDecision
} from "../../../src/routing/routing-state.js";

type ParsedState = { quarantines: unknown[]; decisions: unknown[] };

function migrate(value: unknown): ParsedState {
  const result = routingStateSchema.safeParse(value);
  if (!result.success) throw new Error(`expected a valid state, got ${result.error.message}`);
  return result.data as ParsedState;
}

function refuses(value: unknown): boolean {
  return !routingStateSchema.safeParse(value).success;
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
  return {
    taskId: "T001",
    taskClass: "bounded_feature",
    riskLevel: "low",
    riskFactors: null,
    tier: "implementer",
    reason: "routine",
    at: "2026-08-16T00:00:00.000Z",
    ...overrides
  };
}

async function projectWithRoutingFile(contents: string): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-routing-"));
  const dir = join(projectPath, ".visp", "hyper");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "routing.json"), contents, "utf8");
  return projectPath;
}

describe("routing state migration", () => {
  it("refuses a stored value that is not an object at all", () => {
    expect(refuses("not a state")).toBe(true);
    expect(refuses(["quarantines"])).toBe(true);
    expect(refuses(null)).toBe(true);
  });

  it("refuses a store whose quarantines or decisions are not lists", () => {
    // The migration must not invent a list here. Handing the schema a
    // non-list keeps the failure at the schema, where the caller degrades to
    // an empty state with a warning.
    expect(refuses({ quarantines: { localized_bug: 3 }, decisions: [] })).toBe(true);
    expect(refuses({ quarantines: [], decisions: "none" })).toBe(true);
  });

  it("drops a quarantine entry that is not an object", () => {
    const state = migrate({
      quarantines: [null, "refactor", { taskClass: "refactor", untilSessionCount: 2 }],
      decisions: []
    });
    expect(state.quarantines).toEqual([{ taskClass: "refactor", untilSessionCount: 2 }]);
  });

  it("drops a quarantine whose taskClass is neither a string nor null", () => {
    // A number here is a corrupt file, not an old one. `null` (every class) and
    // an unknown string (see below) both have a migration; this does not.
    //
    // The surviving entry deliberately runs SHORTER than the corrupt one: if the
    // corrupt entry were widened to `null` instead of dropped, it would win the
    // per-class fold and show up as 9. Equal counts here would let widening and
    // dropping produce the same answer, and the test would hold nothing.
    const state = migrate({
      quarantines: [
        { taskClass: 7, untilSessionCount: 9 },
        { taskClass: null, untilSessionCount: 4 }
      ],
      decisions: []
    });
    expect(state.quarantines).toEqual([{ taskClass: null, untilSessionCount: 4 }]);
  });

  it("widens a quarantine on an unrecognised task class to every class", () => {
    // A class this build no longer knows cannot be narrowed to nothing —
    // dropping it would quietly LIFT a quarantine. It widens to `null`, which
    // is the conservative direction.
    const state = migrate({
      quarantines: [{ taskClass: "unknown_class_from_the_future", untilSessionCount: 3 }],
      decisions: []
    });
    expect(state.quarantines).toEqual([{ taskClass: null, untilSessionCount: 3 }]);
  });

  it("keeps one quarantine per class, the longest-running one", () => {
    const ascending = migrate({
      quarantines: [
        { taskClass: "refactor", untilSessionCount: 1 },
        { taskClass: "refactor", untilSessionCount: 5 }
      ],
      decisions: []
    });
    const descending = migrate({
      quarantines: [
        { taskClass: "refactor", untilSessionCount: 5 },
        { taskClass: "refactor", untilSessionCount: 1 }
      ],
      decisions: []
    });

    // Order of appearance must not decide it: a later, SHORTER quarantine
    // replacing a longer one would end a quarantine early.
    expect(ascending.quarantines).toEqual([{ taskClass: "refactor", untilSessionCount: 5 }]);
    expect(descending.quarantines).toEqual([{ taskClass: "refactor", untilSessionCount: 5 }]);
  });

  it("keeps the all-classes quarantine separate from a named one", () => {
    const state = migrate({
      quarantines: [
        { taskClass: null, untilSessionCount: 2 },
        { taskClass: "security", untilSessionCount: 9 }
      ],
      decisions: []
    });
    expect(state.quarantines).toEqual([
      { taskClass: null, untilSessionCount: 2 },
      { taskClass: "security", untilSessionCount: 9 }
    ]);
  });

  it("drops a decision entry that is not an object", () => {
    const state = migrate({ quarantines: [], decisions: ["T001", null, decision()] });
    expect(state.decisions).toEqual([decision()]);
  });

  it("moves a legacy risk level out of taskClass and into riskLevel", () => {
    // Before task classes existed, `taskClass` held "low" | "medium" | "high".
    // Reading that as a class would make every old decision unparseable and
    // throw the whole history away.
    const state = migrate({
      quarantines: [],
      decisions: [
        {
          taskId: "T001",
          taskClass: "high",
          tier: "implementer",
          reason: "legacy",
          at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    expect(state.decisions).toEqual([
      {
        taskId: "T001",
        taskClass: null,
        riskLevel: "high",
        riskFactors: null,
        tier: "implementer",
        reason: "legacy",
        at: "2026-01-01T00:00:00.000Z"
      }
    ]);
  });

  it("leaves a decision that already carries a real class and its own risk level alone", () => {
    const state = migrate({
      quarantines: [],
      decisions: [decision({ taskClass: "security", riskLevel: "medium" })]
    });
    expect(state.decisions).toEqual([decision({ taskClass: "security", riskLevel: "medium" })]);
  });

  it("prefers the risk level found in taskClass when a half-migrated file carries both", () => {
    // A risk level sitting in `taskClass` identifies the OLD writer, and that
    // writer never wrote a `riskLevel` field — so a `riskLevel` beside it was
    // put there by something else, and the legacy value is the one that
    // actually describes this decision.
    const state = migrate({
      quarantines: [],
      decisions: [{ ...decision(), taskClass: "high", riskLevel: "medium" }]
    });
    expect(state.decisions).toEqual([decision({ taskClass: null, riskLevel: "high" })]);
  });

  it("fills a missing riskLevel and riskFactors with null rather than refusing the decision", () => {
    const state = migrate({
      quarantines: [],
      decisions: [
        {
          taskId: "T002",
          taskClass: "refactor",
          tier: "scout",
          reason: "no risk recorded",
          at: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
    expect(state.decisions).toEqual([
      {
        taskId: "T002",
        taskClass: "refactor",
        riskLevel: null,
        riskFactors: null,
        tier: "scout",
        reason: "no risk recorded",
        at: "2026-01-01T00:00:00.000Z"
      }
    ]);
  });

  it("drops a decision whose taskClass is neither a string nor null", () => {
    const state = migrate({
      quarantines: [],
      decisions: [{ ...decision(), taskClass: 7 }, decision()]
    });
    expect(state.decisions).toEqual([decision()]);
  });

  it("widens a decision's unrecognised task class to null instead of dropping it", () => {
    const state = migrate({
      quarantines: [],
      decisions: [decision({ taskClass: "unknown_class" as never })]
    });
    expect(state.decisions).toEqual([decision({ taskClass: null })]);
  });
});

describe("routing state store", () => {
  it("reads a missing store as empty with no warning", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-routing-"));
    const { state, warnings } = await readRoutingState(projectPath);
    expect(state).toEqual({ quarantines: [], decisions: [] });
    expect(warnings).toEqual([]);
  });

  it("degrades a corrupt store to empty and says so once", async () => {
    const projectPath = await projectWithRoutingFile("{ not json");
    const { state, warnings } = await readRoutingState(projectPath);
    expect(state).toEqual({ quarantines: [], decisions: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("routing.json");
    expect(warnings[0]).toContain("an empty state");
  });

  it("degrades a store the migration cannot repair to empty and says so once", async () => {
    const projectPath = await projectWithRoutingFile(JSON.stringify({ quarantines: 3 }));
    const { state, warnings } = await readRoutingState(projectPath);
    expect(state).toEqual({ quarantines: [], decisions: [] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("did not match the expected schema");
  });

  it("round-trips a migrated legacy store through a write", async () => {
    const projectPath = await projectWithRoutingFile(
      JSON.stringify({
        quarantines: [{ taskClass: "refactor", untilSessionCount: 1 }],
        decisions: [
          {
            taskId: "T001",
            taskClass: "high",
            tier: "implementer",
            reason: "legacy",
            at: "2026-01-01T00:00:00.000Z"
          }
        ]
      })
    );
    const { state } = await readRoutingState(projectPath);
    await writeRoutingState(projectPath, state);

    const written = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "routing.json"), "utf8")
    ) as ParsedState;
    expect(written.decisions).toEqual([
      {
        taskId: "T001",
        taskClass: null,
        riskLevel: "high",
        riskFactors: null,
        tier: "implementer",
        reason: "legacy",
        at: "2026-01-01T00:00:00.000Z"
      }
    ]);
  });

  it("caps the recorded history at the fifty most recent decisions", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-routing-"));
    for (let index = 0; index < 55; index += 1) {
      await recordRoutingDecision(projectPath, decision({ taskId: `T${index}` }));
    }

    const { state } = await readRoutingState(projectPath);
    expect(state.decisions).toHaveLength(50);
    // The cap keeps the newest, not the first fifty — a history that stopped
    // recording after fifty sessions would be worse than none.
    expect(state.decisions[0]?.taskId).toBe("T5");
    expect(state.decisions.at(-1)?.taskId).toBe("T54");
  });
});
