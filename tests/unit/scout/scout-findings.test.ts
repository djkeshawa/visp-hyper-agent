import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ensureDir } from "../../../src/core/fs-utils.js";
import {
  SCOUT_ACTIONS,
  SCOUT_MAX_ACTIONS,
  collectScoutFindings,
  readScoutFindings,
  renderScoutState
} from "../../../src/scout/scout-findings.js";

type Payload = Record<string, unknown>;

function payload(overrides: Payload = {}): Payload {
  return {
    schemaVersion: "1.0",
    taskId: "T001",
    snapshotId: "urn:visp-intel:snapshot:1.0:sha256:aaa",
    repositoryInstanceId: "urn:visp-intel:repository-instance:1.0:sha256:bbb",
    status: "resolved",
    entrypoints: [
      { entityId: "ent:handler-a", filePath: "src/a.ts", line: 11, receiptId: "rcp:1" }
    ],
    path: [
      {
        relationId: "rel:1",
        sourceId: "ent:handler-a",
        targetId: "ent:store",
        kind: "calls",
        receiptId: "rcp:2"
      }
    ],
    affectedTests: [
      { entityId: "ent:test-a", filePath: "tests/a.test.ts", receiptId: "rcp:3" }
    ],
    unresolved: [],
    receiptIds: ["rcp:1", "rcp:2", "rcp:3"],
    budget: { actions: 4, maxActions: SCOUT_MAX_ACTIONS },
    ...overrides
  };
}

async function projectWithFindings(body: string): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "vh-scout-"));
  await ensureDir(join(project, ".visp", "hyper", "current"));
  await writeFile(join(project, ".visp", "hyper", "current", "scout-findings.json"), body, "utf8");
  return project;
}

describe("the bounded action set (ADR 0014 Q4)", () => {
  it("names exactly the six actions and caps the run at twelve", () => {
    expect([...SCOUT_ACTIONS]).toEqual(["search", "callers", "callees", "path", "entity", "tests"]);
    expect(SCOUT_MAX_ACTIONS).toBe(12);
  });

  it("accepts a well-formed resolved run", () => {
    const report = collectScoutFindings(payload());
    expect(report.state).toBe("accepted");
    expect(report.reasons).toEqual([]);
    expect(report.dropped).toEqual([]);
    expect(report.findings?.path).toHaveLength(1);
    expect(report.findings?.receiptIds).toEqual(["rcp:1", "rcp:2", "rcp:3"]);
  });

  it("rejects a run that spends more than twelve actions", () => {
    const report = collectScoutFindings(
      payload({ budget: { actions: 13, maxActions: SCOUT_MAX_ACTIONS } })
    );
    expect(report.state).toBe("rejected");
    expect(report.reasons.join(" ")).toContain("over the hard cap");
  });

  it("rejects a run that restates its own cap", () => {
    const report = collectScoutFindings(payload({ budget: { actions: 30, maxActions: 40 } }));
    expect(report.state).toBe("rejected");
    expect(report.reasons.join(" ")).toContain("may not restate its own cap");
  });

  it("keeps only the six action names in attemptedActions", () => {
    const report = collectScoutFindings(
      payload({
        status: "unresolved",
        unresolved: [
          {
            question: "which store does the handler write to?",
            attemptedActions: ["search", "grep", "callees", "Bash"],
            unknownId: null
          }
        ]
      })
    );
    expect(report.state).toBe("accepted");
    expect(report.findings?.unresolved[0]?.attemptedActions).toEqual(["search", "callees"]);
    expect(report.dropped.filter((entry) => entry.includes("six-action set"))).toHaveLength(2);
  });
});

describe("receipts", () => {
  it("drops a row with no receipt AND rejects the payload that carried it", () => {
    const report = collectScoutFindings(
      payload({
        entrypoints: [
          { entityId: "ent:handler-a", filePath: "src/a.ts", line: 11, receiptId: "rcp:1" },
          { entityId: "ent:handler-b", filePath: "src/b.ts", line: 4 }
        ]
      })
    );
    expect(report.state).toBe("rejected");
    expect(report.reasons).toContain("at least one row cited no receipt");
    expect(report.dropped).toContain("entrypoints[1] dropped: no receiptId");
    expect(report.findings).toBeUndefined();
  });

  it("treats a blank receipt as no receipt", () => {
    const report = collectScoutFindings(
      payload({
        path: [
          {
            relationId: "rel:1",
            sourceId: "a",
            targetId: "b",
            kind: "calls",
            receiptId: "   "
          }
        ]
      })
    );
    expect(report.state).toBe("rejected");
    expect(report.reasons).toContain("at least one row cited no receipt");
  });

  it("widens the receipt ledger rather than narrowing it", () => {
    // A search that returned nothing still produced a receipt. Dropping it would
    // make an honest unresolved run look like an idle one.
    const report = collectScoutFindings(payload({ receiptIds: ["rcp:9", "rcp:1"] }));
    expect(report.state).toBe("accepted");
    expect(report.findings?.receiptIds).toEqual(["rcp:1", "rcp:2", "rcp:3", "rcp:9"]);
  });
});

describe("self-consistency", () => {
  it("rejects resolved with an empty path", () => {
    const report = collectScoutFindings(payload({ path: [] }));
    expect(report.state).toBe("rejected");
    expect(report.reasons.join(" ")).toContain("no receipted path relation survived");
  });

  it("rejects resolved when the only path row lost its receipt", () => {
    const report = collectScoutFindings(
      payload({
        path: [{ relationId: "rel:1", sourceId: "a", targetId: "b", kind: "calls" }]
      })
    );
    expect(report.state).toBe("rejected");
    expect(report.reasons.join(" ")).toContain("no receipted path relation survived");
  });

  it("accepts an honest unresolved run with an empty path", () => {
    const report = collectScoutFindings(
      payload({
        status: "unresolved",
        path: [],
        unresolved: [
          {
            question: "no call edge resolves between the route and the store",
            attemptedActions: ["search", "path"],
            unknownId: "unk:7"
          }
        ]
      })
    );
    expect(report.state).toBe("accepted");
    expect(report.findings?.status).toBe("unresolved");
    expect(report.findings?.unresolved[0]?.unknownId).toBe("unk:7");
  });

  it("rejects unresolved with nothing populated", () => {
    const report = collectScoutFindings(
      payload({ status: "unresolved", path: [], unresolved: [{ question: "  " }] })
    );
    expect(report.state).toBe("rejected");
    expect(report.reasons.join(" ")).toContain("no populated unresolved entry survived");
  });

  it("rejects a payload missing its snapshot or repository identity", () => {
    for (const missing of ["snapshotId", "repositoryInstanceId", "taskId"]) {
      const report = collectScoutFindings(payload({ [missing]: "" }));
      expect(report.state).toBe("rejected");
      expect(report.reasons.join(" ")).toContain("malformed");
    }
  });
});

describe("identity, never display", () => {
  it("keeps two entities that share a file-level name", () => {
    // The Phase 19 false-edge defects all came from treating a name as an
    // identity. Two `handler`s in two files are two rows.
    const report = collectScoutFindings(
      payload({
        entrypoints: [
          { entityId: "ent:a#handler", filePath: "src/a.ts", line: 3, receiptId: "rcp:1" },
          { entityId: "ent:b#handler", filePath: "src/b.ts", line: 3, receiptId: "rcp:1" }
        ]
      })
    );
    expect(report.state).toBe("accepted");
    expect(report.findings?.entrypoints).toHaveLength(2);
  });

  it("deduplicates on entity identity, not on file path", () => {
    const report = collectScoutFindings(
      payload({
        affectedTests: [
          { entityId: "ent:t1", filePath: "tests/a.test.ts", receiptId: "rcp:3" },
          { entityId: "ent:t2", filePath: "tests/a.test.ts", receiptId: "rcp:3" },
          { entityId: "ent:t1", filePath: "tests/elsewhere.test.ts", receiptId: "rcp:4" }
        ]
      })
    );
    expect(report.state).toBe("accepted");
    expect(report.findings?.affectedTests.map((row) => row.entityId)).toEqual(["ent:t1", "ent:t2"]);
    expect(report.dropped).toContain("affectedTests[2] dropped: duplicate of an earlier row");
  });
});

describe("the transcript does not cross the boundary", () => {
  it("truncates a question used to smuggle prose through", () => {
    const prose = "x".repeat(5_000);
    const report = collectScoutFindings(
      payload({
        status: "unresolved",
        path: [],
        unresolved: [{ question: prose, attemptedActions: [], unknownId: null }]
      })
    );
    expect(report.state).toBe("accepted");
    expect(report.findings?.unresolved[0]?.question.length).toBeLessThanOrEqual(201);
    expect(report.dropped.join(" ")).toContain("truncated");
  });

  it("caps the number of unresolved entries", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      question: `question ${index}`,
      attemptedActions: ["search"],
      unknownId: null
    }));
    const report = collectScoutFindings(payload({ status: "unresolved", path: [], unresolved: many }));
    expect(report.state).toBe("accepted");
    expect(report.findings?.unresolved).toHaveLength(SCOUT_MAX_ACTIONS);
  });

  it("carries no field the scout did not declare", () => {
    const report = collectScoutFindings(
      payload({
        narrative: "here is everything I thought about",
        entrypoints: [
          {
            entityId: "ent:a",
            filePath: "src/a.ts",
            line: 1,
            receiptId: "rcp:1",
            reasoning: "I picked this because it looked right"
          }
        ]
      })
    );
    expect(report.state).toBe("accepted");
    expect(JSON.stringify(report.findings)).not.toContain("reasoning");
    expect(JSON.stringify(report.findings)).not.toContain("narrative");
  });
});

describe("rendering", () => {
  it("renders zero-based lines as one-based exactly once", () => {
    const report = collectScoutFindings(payload());
    const rendered = renderScoutState(report);
    // intel reported line 11 (zero-based); the editor line is 12.
    expect(rendered).toContain("ent:handler-a @ src/a.ts:12");
    expect(rendered).toContain("BEGIN_VISP_SCOUT_STATE");
    expect(rendered).toContain("END_VISP_SCOUT_STATE");
    expect(rendered).toContain("budget: 4/12 actions");
  });

  it("names why a payload was rejected instead of rendering its rows", () => {
    const rendered = renderScoutState(collectScoutFindings(payload({ path: [] })));
    expect(rendered).toContain("state: rejected");
    expect(rendered).toContain("rejected_because:");
    expect(rendered).not.toContain("ent:handler-a");
  });
});

describe("reading from a project", () => {
  it("reports absence without failing", async () => {
    const project = await mkdtemp(join(tmpdir(), "vh-scout-none-"));
    const report = await readScoutFindings(project);
    expect(report.state).toBe("absent");
    expect(report.findings).toBeUndefined();
  });

  it("rejects unparseable findings", async () => {
    const project = await projectWithFindings("{not json");
    const report = await readScoutFindings(project);
    expect(report.state).toBe("rejected");
    expect(report.reasons).toContain("scout findings are not valid JSON");
  });

  it("collects a written payload", async () => {
    const project = await projectWithFindings(JSON.stringify(payload()));
    const report = await readScoutFindings(project);
    expect(report.state).toBe("accepted");
    expect(report.findings?.taskId).toBe("T001");
  });
});
