// LC-110 — `visp handoff` and `visp status` contradicted each other within the
// same minute, on the same project:
//
//     visp handoff  ->  done — the PR gate is open — the change is ready to
//                       hand off
//     visp status   ->  Verdict: inconclusive
//                       Task: T009 — ... (pending)
//
// A caller acting on `handoff` opens a PR that `status` says is not ready. The
// two verbs were reading two different Kit surfaces: handoff the `prAllowed`
// flag on `visp-kit next`, status the negotiated canonical WorkflowAction.
// Combining a Kit flag into a readiness sentence the canonical action
// contradicts is Hyper holding its own opinion on PR readiness, which
// `kit_strict` forbids (AGENTS.md rule 3).
//
// The shim answers the two surfaces separately — `next` for the legacy flag,
// `next --format json --protocol …` for the canonical action — which is the
// only way to construct the disagreement the ticket reports.

import { delimiter, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../../src/cli/index.js";
import {
  canonicalKitSpec,
  createCanonicalProject,
  workflowActionV3Fixture
} from "../../../helpers/canonical-action-fixture.js";
import { createVispShim } from "../../../helpers/visp-shim.js";
import { readStateIfInitialized } from "../../../../src/core/session-manager.js";

const originalPath = process.env.PATH;

let projectPath: string;

beforeEach(async () => {
  projectPath = await createCanonicalProject();
});

afterEach(() => {
  process.env.PATH = originalPath;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/**
 * A Kit whose legacy `next` says the PR gate is open while its canonical
 * action says otherwise — the exact split LC-110 reports.
 *
 * `canonicalVerdict: "ready"` makes the two surfaces agree, which is the
 * control: the readiness sentence must still be reachable.
 */
async function stubKit(canonicalVerdict: "ready" | "inconclusive" | "blocked"): Promise<void> {
  // A verdict has to be coherent with its findings or the adapter rejects the
  // action outright, which would test the fail-closed path instead of the
  // disagreement. `uncertain` carries inconclusive; `blocks` carries blocked.
  const effect = canonicalVerdict === "ready" ? "none" : canonicalVerdict === "blocked" ? "blocks" : "uncertain";
  const action = workflowActionV3Fixture({
    verdict: canonicalVerdict,
    findings:
      effect === "none"
        ? []
        : [
            {
              code: "VSP020",
              source: "workflow",
              severity: canonicalVerdict === "blocked" ? "error" : "warning",
              effect,
              message: "The implementation checklist for T001 is still open.",
              recommendation: "Finish the task and record its evidence.",
              evidence: []
            }
          ],
    task: {
      id: "T001",
      title: "First task",
      status: canonicalVerdict === "ready" ? "ready" : "pending",
      dependsOn: [],
      parallelizable: false
    }
  });
  const shim = await createVispShim(
    canonicalKitSpec({
      action,
      extra: {
        // The legacy surface handoff used to decide on, by itself.
        next: {
          stdout: {
            success: true,
            prAllowed: true,
            implementationAllowed: true,
            nextCommand: "visp-kit verify --task T001"
          }
        },
        // The canonical surface `visp status` reads. `next --format json …`
        // filters down to this key; bare `next` does not.
        "next json": { stdout: action }
      }
    })
  );
  process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
}

async function runHandoff(): Promise<{ output: string; exitCode: number | undefined }> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.exitCode = undefined;
  await runCli(["node", "visp-hyper", "--project", projectPath, "handoff"]);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { output: lines.join("\n"), exitCode };
}

async function runStatus(): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.exitCode = undefined;
  await runCli(["node", "visp-hyper", "--project", projectPath, "status"]);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return lines.join("\n");
}

describe("handoff and status read one verdict", () => {
  it("does not report the change ready while the canonical action says inconclusive", async () => {
    await stubKit("inconclusive");

    const { output, exitCode } = await runHandoff();

    expect(
      output,
      "the reported defect: handoff declared the PR gate open on a project status called inconclusive"
    ).not.toContain("the PR gate is open");
    expect(output, "'done' was the word a caller acted on").not.toContain("visp handoff: done");
    expect(output).toContain("inconclusive");
    expect(exitCode, "status exits 1 on an unready verdict; handoff must not exit 0 on the same project").toBe(1);
  });

  it("shows the caller the same verdict status would have shown", async () => {
    await stubKit("inconclusive");

    const handoff = (await runHandoff()).output;
    const status = await runStatus();

    // Not a formatting assertion: the point is that handoff's refusal carries
    // Kit's own answer, so nobody has to run a second verb to find out which
    // of the two was telling the truth.
    expect(status).toContain("Verdict: inconclusive");
    expect(handoff).toContain("Verdict: inconclusive");
    expect(handoff).toContain("Task:    T001");
  });

  it("refuses rather than claiming readiness when the canonical action is blocked", async () => {
    await stubKit("blocked");

    const { output, exitCode } = await runHandoff();

    expect(output).not.toContain("the PR gate is open");
    expect(output).toContain("visp handoff: blocked");
    expect(exitCode).toBe(1);
  });

  it("still hands off when both of Kit's surfaces agree", async () => {
    // The control. A fix that only ever refuses would satisfy the assertions
    // above and remove the verb.
    await stubKit("ready");

    const { output, exitCode } = await runHandoff();

    expect(output).toContain("the PR gate is open — the change is ready to hand off");
    expect(exitCode).toBeUndefined();
  });

  it("records the refusal in Hyper's own store, like every other stop", async () => {
    await stubKit("inconclusive");

    await runHandoff();

    const state = await readStateIfInitialized(projectPath);
    expect(state?.activity?.at(-1)).toMatchObject({ verb: "handoff", outcome: "blocked" });
  });
});
