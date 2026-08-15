// The eighth silent failure: an empty state file after a full working session.
//
// A head-to-head evaluation ran an agent through `visp setup`, `visp new`, and
// then a real implementation task. Afterwards the agent's own report claimed
// Hyper "drove feature registration and task sequencing". The only artifact
// that could have supported that claim was `.visp/hyper/state.json`, and it
// read, in full:
//
//   {"activeSessionId": null, "sessions": {}}
//
// The claim was therefore unsupported, and the evaluation concluded Hyper had
// done nothing. Both halves of that were wrong in an instructive way.
//
// ROOT CAUSE, verified against a real Kit binary in a scratch project:
// `createSession` has exactly one caller — `executeStart` in start.ts, reached
// only by `visp work` and the legacy `visp start`. The Kit-backed verbs `new`,
// `plan`, `check` and `handoff` drive Kit through the bridge and touch Hyper's
// own store not at all. `visp new` does not even CREATE `.visp/hyper/`. So a
// session driven entirely through those verbs left a store byte-identical to a
// project where Hyper had never been installed, and no surface said so:
//
//   $ visp doctor
//   Overall: PASS
//   [PASS] Visp Hyper state: Found .visp/hyper/config.json and .visp/hyper/state.json.
//
//   $ visp status
//   Phase:   spec ...          # Kit's action, and not one word about Hyper
//
// A check that passes because two files exist is the same defect as a CI job
// that goes green because every step skipped. The store now records the verbs
// that ran, and both surfaces read what it says instead of that it is there.

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/index.js";
import {
  canonicalKitSpec,
  createCanonicalProject
} from "./helpers/canonical-action-fixture.js";
import { createVispShim } from "./helpers/visp-shim.js";
import { defaultConfig } from "../src/core/defaults.js";
import {
  MAX_ACTIVITY_RECORDS,
  readState,
  readStateIfInitialized,
  recordVerbActivity,
  renderDrivenWithoutSession,
  summarizeCoordination
} from "../src/core/session-manager.js";
import type { HyperState } from "../src/core/types.js";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "visp-activity-"));
  await execFileAsync("git", ["init"], { cwd: projectPath });
});

afterEach(() => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
});

/** The exact bytes the head-to-head evaluation found on disk. */
const HEAD_TO_HEAD_STATE = '{\n  "activeSessionId": null,\n  "sessions": {}\n}\n';

async function initializeHyper(state = HEAD_TO_HEAD_STATE): Promise<void> {
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(
    join(projectPath, ".visp", "hyper", "config.json"),
    `${JSON.stringify(defaultConfig, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(projectPath, ".visp", "hyper", "state.json"), state, "utf8");
}

async function readStateFile(): Promise<HyperState> {
  return JSON.parse(
    await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
  ) as HyperState;
}

describe("the store records that Hyper was here", () => {
  it("stops reading as an untouched project once a verb has run", async () => {
    await initializeHyper();
    expect(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).toBe(
      HEAD_TO_HEAD_STATE
    );

    await recordVerbActivity(projectPath, {
      verb: "new",
      outcome: "human-needed",
      detail: "visp-kit clarify needs more detail before it can pass:"
    });

    const state = await readStateFile();
    expect(state.sessions).toEqual({});
    expect(state.activity).toHaveLength(1);
    expect(state.activity?.[0]).toMatchObject({
      verb: "new",
      outcome: "human-needed",
      detail: "visp-kit clarify needs more detail before it can pass:"
    });
    expect(Date.parse(state.activity![0]!.at)).not.toBeNaN();
  });

  it("creates the store when a verb runs before anything else has initialized it", async () => {
    // `visp new` did not create `.visp/hyper/` at all, which is why the
    // head-to-head file could only have come from `setup`.
    await recordVerbActivity(projectPath, { verb: "new", outcome: "goal-reached" });

    const state = await readStateFile();
    expect(state.activity?.map((entry) => entry.verb)).toEqual(["new"]);
  });

  it("keeps the trail bounded and drops the oldest first", async () => {
    await initializeHyper();
    for (let index = 0; index < MAX_ACTIVITY_RECORDS + 3; index += 1) {
      await recordVerbActivity(projectPath, { verb: `v${index}`, outcome: "goal-reached" });
    }

    const state = await readStateFile();
    expect(state.activity).toHaveLength(MAX_ACTIVITY_RECORDS);
    expect(state.activity?.[0]?.verb).toBe("v3");
    expect(state.activity?.at(-1)?.verb).toBe(`v${MAX_ACTIVITY_RECORDS + 2}`);
  });

  it("stores one clipped line of detail, never a multi-line report", async () => {
    await initializeHyper();
    await recordVerbActivity(projectPath, {
      verb: "plan",
      outcome: "human-needed",
      detail: `${"x".repeat(400)}\nsecond line`
    });

    const detail = (await readStateFile()).activity?.[0]?.detail ?? "";
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual(200);
    expect(detail.endsWith("…")).toBe(true);
  });

  it("never lets bookkeeping fail the verb that already did the work", async () => {
    // A real unwritable store, not a mocked one: `state.json` occupied by a
    // directory makes the atomic rename fail the way a read-only checkout or a
    // permissions problem would.
    await mkdir(join(projectPath, ".visp", "hyper", "state.json"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      recordVerbActivity(projectPath, { verb: "new", outcome: "goal-reached" })
    ).resolves.toBeUndefined();

    expect(warn.mock.calls.flat().join(" ")).toContain("activity trail is now incomplete");
  });

  it("loses only the audit trail when an activity row is unreadable, never the sessions", async () => {
    // Blast radius. Every other field in this store is strict on purpose; a
    // hand-edited or newer-format activity row must not cost a reader the
    // session records sitting beside it.
    await initializeHyper(
      JSON.stringify({
        activeSessionId: "vh_1",
        sessions: {
          vh_1: {
            id: "vh_1",
            goal: "ship it",
            tool: "claude-code",
            projectPath,
            createdAt: "2026-08-15T00:00:00.000Z",
            updatedAt: "2026-08-15T00:00:00.000Z",
            phase: "implementation",
            relevantFiles: []
          }
        },
        activity: [{ at: "2026-08-15T00:00:00.000Z", verb: "new", outcome: "teleported" }]
      })
    );

    const state = await readState(projectPath);
    expect(Object.keys(state.sessions)).toEqual(["vh_1"]);
    expect(state.activity ?? []).toEqual([]);
  });
});

describe("the head-to-head run itself, end to end", () => {
  /**
   * A stand-in Kit that reproduces the exact sequence the evaluation hit:
   * `visp new` registers the feature, drives `scan`, then `clarify` fails its
   * own freshly generated all-TBD draft and the composite stops for a human.
   * The real run against visp-kit 0.6.0 printed precisely this and left
   * `.visp/hyper/` non-existent.
   */
  async function stubKitStoppingAtClarify(): Promise<void> {
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}", "utf8");
    const binDir = join(projectPath, "bin");
    await mkdir(binDir, { recursive: true });
    const shim = join(binDir, "visp-kit");
    await writeFile(
      shim,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const marker = ${JSON.stringify(join(projectPath, ".visp", "scanned"))};`,
        "const sub = process.argv[2];",
        'if (sub === "status") {',
        '  process.stdout.write(JSON.stringify({ success: true, initialized: true }));',
        "  process.exit(0);",
        "}",
        'if (sub === "next") {',
        "  process.stdout.write(JSON.stringify({",
        "    success: true,",
        '    nextCommand: fs.existsSync(marker) ? "visp-kit clarify" : "visp-kit scan"',
        "  }));",
        "  process.exit(0);",
        "}",
        'if (sub === "scan") {',
        '  fs.writeFileSync(marker, "ran");',
        '  process.stdout.write(JSON.stringify({ success: true }));',
        "  process.exit(0);",
        "}",
        'if (sub === "clarify") {',
        "  process.stdout.write(JSON.stringify({",
        "    success: false,",
        '    validation: { errors: ["Clarifications must be marked ready before workflow advancement."] },',
        '    feature: { path: ".visp/features/001-a-farewell-message" }',
        "  }));",
        "  process.exit(1);",
        "}",
        'process.stdout.write(JSON.stringify({ success: true }));',
        "process.exit(0);"
      ].join("\n"),
      "utf8"
    );
    await chmod(shim, 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
  }

  it("leaves a state file that answers 'did Hyper do anything here'", async () => {
    await stubKitStoppingAtClarify();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.exitCode = undefined;

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "new",
      "add a farewell message to app.js"
    ]);
    process.exitCode = undefined;

    // Before this change the assertion below could not be written: `visp new`
    // did not create `.visp/hyper/` at all, and `visp setup` left it holding
    // `{"activeSessionId": null, "sessions": {}}` — a file indistinguishable
    // from a project Hyper had never touched.
    const state = await readStateFile();
    expect(state.sessions, "new does not and should not create a session").toEqual({});
    expect(state.activity).toHaveLength(1);
    expect(state.activity?.[0]).toMatchObject({ verb: "new", outcome: "human-needed" });
    expect(state.activity?.[0]?.detail).toContain("needs more detail");
    expect(summarizeCoordination(state).drivenWithoutSession).toBe(true);
  });
});

describe("summarizeCoordination distinguishes the three cases that looked identical", () => {
  it("reads an untouched store as untouched", () => {
    const summary = summarizeCoordination({ activeSessionId: null, sessions: {} });
    expect(summary).toMatchObject({ sessionCount: 0, activityCount: 0, drivenWithoutSession: false });
  });

  it("reads verbs-without-a-session as the loud case", () => {
    const summary = summarizeCoordination({
      activeSessionId: null,
      sessions: {},
      activity: [
        { at: "2026-08-15T10:00:00.000Z", verb: "new", outcome: "human-needed" },
        { at: "2026-08-15T11:00:00.000Z", verb: "plan", outcome: "goal-reached", detail: "run visp work" }
      ]
    });

    expect(summary.drivenWithoutSession).toBe(true);
    expect(summary.lastActivity?.verb).toBe("plan");

    const sentence = renderDrivenWithoutSession(summary);
    expect(sentence).toContain("recorded NO session");
    expect(sentence).toContain("visp plan");
    expect(sentence).toContain("2026-08-15T11:00:00.000Z");
    expect(sentence).toContain("visp work");
  });

  it("says nothing loud once a session exists", () => {
    const summary = summarizeCoordination({
      activeSessionId: "vh_1",
      sessions: {
        vh_1: {
          id: "vh_1",
          goal: "g",
          tool: "generic",
          projectPath: "/tmp/x",
          createdAt: "2026-08-15T00:00:00.000Z",
          updatedAt: "2026-08-15T00:00:00.000Z",
          phase: "implementation",
          relevantFiles: []
        }
      },
      activity: [{ at: "2026-08-15T10:00:00.000Z", verb: "new", outcome: "goal-reached" }]
    });
    expect(summary.drivenWithoutSession).toBe(false);
  });
});

describe("doctor reports what the store says, not that it exists", () => {
  async function doctorCheck(id: string): Promise<{ status: string; detail: string } | undefined> {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);
    process.exitCode = undefined;
    const summary = JSON.parse(logs.join("")) as {
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    return summary.checks.find((check) => check.id === id);
  }

  it("no longer passes an initialized-but-empty store off as a green tick with no qualifier", async () => {
    await initializeHyper();

    const check = await doctorCheck("hyper-state");

    expect(check?.status).toBe("pass");
    // The old detail was "Found .visp/hyper/config.json and .visp/hyper/state.json."
    // — true, and an answer to a question nobody asked.
    expect(check?.detail).not.toContain("Found .visp/hyper/config.json");
    expect(check?.detail).toContain("no work-driving verb has run");
  });

  it("warns, in sentences, when verbs ran here and produced no session", async () => {
    await initializeHyper();
    await recordVerbActivity(projectPath, {
      verb: "new",
      outcome: "human-needed",
      detail: "visp-kit clarify needs more detail"
    });

    const check = await doctorCheck("hyper-state");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("recorded NO session");
    expect(check?.detail).toContain("visp new");
  });

  it("still fails outright when Hyper was never initialized", async () => {
    const check = await doctorCheck("hyper-state");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("has not been initialized");
  });
});

describe("status says it too, in a Kit-backed project", () => {
  /** A canonical project with a healthy Kit on PATH — the head-to-head shape. */
  async function stubKit(): Promise<void> {
    projectPath = await createCanonicalProject();
    const shim = await createVispShim(canonicalKitSpec());
    process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
  }

  async function runStatus(args: string[] = []): Promise<string> {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a) => void logs.push(a.join(" ")));
    process.exitCode = undefined;
    await runCli(["node", "visp-hyper", "--project", projectPath, "status", ...args]);
    process.exitCode = undefined;
    return logs.join("\n");
  }

  it("prints the absence next to Kit's action instead of only Kit's action", async () => {
    await stubKit();
    await initializeHyper();
    await recordVerbActivity(projectPath, { verb: "new", outcome: "human-needed" });

    const output = await runStatus();

    expect(output).toContain("Phase:");
    expect(output, "Kit's action stays first and unchanged").toContain("Next:");
    expect(output).toContain("Hyper ran 1 work-driving verb");
    expect(output).toContain("recorded NO session");
  });

  it("stays quiet when the store has nothing to accuse anyone of", async () => {
    await stubKit();
    await initializeHyper();

    expect(await runStatus()).not.toContain("recorded NO session");
  });

  it("does not create a store just by being asked for status", async () => {
    // A reporting command that initializes would manufacture the very
    // ambiguity this work removes: the next `doctor` would read its own
    // freshly minted empty file as "initialized".
    await stubKit();

    await runStatus();

    expect(await readStateIfInitialized(projectPath)).toBeNull();
  });
});
