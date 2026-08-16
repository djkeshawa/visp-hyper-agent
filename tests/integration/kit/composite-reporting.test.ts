// Part A + C — the composites and `check` report why they stopped.
//
// Dogfooding the four products on a real 7,700-line Rust project produced this
// exchange, twice, at two different stages:
//
//   $ visp new "add a full-screen terminal dashboard…"
//   → visp-kit scan
//   → visp-kit clarify
//   visp new: blocked — visp-kit clarify reported failure. Run it directly for detail.
//
// The composite was holding Kit's `--json` envelope, which already carried the
// validation errors, the feature path and a stage-aware recovery command. It
// parsed `{ success }` and discarded all of it, so every block cost the user a
// second command to learn something the first had already been told.
//
// `visp check` had the identical defect on a different code path: `verify:
// FAILED / review: FAILED` and nothing else, while holding a summary that
// listed the offending files.
//
// The other half of the defect is that "needs a human" was reported as a hard
// failure. A Kit stage is generate → fill in → validate, so a freshly
// generated all-TBD draft failing its own validation is the NORMAL path, not
// an error. It must exit 0 and say what to do next.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KitCommandBridge } from "../../../src/kit/kit-command-bridge.js";
import { putNodeExecutableOnPath } from "../../helpers/fake-executable.js";

const originalPath = process.env.PATH;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "visp-composite-report-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
});

/** A stand-in Kit that answers with a fixed JSON envelope and exit code. */
async function stubKit(envelope: unknown, exitCode: number): Promise<void> {
  await writeShim(
    [
      `process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`,
      `process.exit(${exitCode});`
    ].join("\n")
  );
}

/**
 * A stand-in Kit that answers each subcommand the way a real one would.
 *
 * The verbs probe availability (`status`) and ask what is next (`next`) before
 * executing anything, so a one-answer-fits-all stub never reaches the code
 * under test. This one is faithful enough to get there: healthy status, a
 * `next` that names the stage, and the stage itself failing.
 */
async function stubKitWorkflow(stageEnvelope: unknown): Promise<void> {
  await mkdir(join(tempDir, ".visp"), { recursive: true });
  await writeFile(join(tempDir, ".visp", "policy.json"), "{}", "utf8");

  await writeShim(
    [
      'const sub = process.argv[2];',
      'if (sub === "status") {',
      '  process.stdout.write(JSON.stringify({ success: true, initialized: true }));',
      '  process.exit(0);',
      '}',
      'if (sub === "next") {',
      '  process.stdout.write(JSON.stringify({ success: true, nextCommand: "visp-kit spec" }));',
      '  process.exit(0);',
      '}',
      `process.stdout.write(${JSON.stringify(JSON.stringify(stageEnvelope))});`,
      'process.exit(1);'
    ].join("\n")
  );
}

async function writeShim(body: string): Promise<void> {
  await putNodeExecutableOnPath(join(tempDir, "bin"), "visp-kit", body);
}

describe("the bridge keeps what Kit already told it", () => {
  it("carries validation errors, the feature path and the recovery command", async () => {
    await stubKit(
      {
        success: false,
        validation: { errors: ["spec.userStories[0].title contains placeholder text."] },
        feature: { path: ".visp/features/001-a-feature" },
        recovery: "visp-kit clarify --validate"
      },
      1
    );
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const result = await bridge.runMechanicalArgv("spec", []);

    expect(result).not.toBeNull();
    expect(result?.success).toBe(false);
    expect(result?.validationErrors).toHaveLength(1);
    expect(result?.featurePath).toBe(".visp/features/001-a-feature");
    expect(result?.recovery).toBe("visp-kit clarify --validate");
  });

  it("still parses an envelope with none of the optional fields", async () => {
    // An older Kit must keep working — the fields are additive.
    await stubKit({ success: true }, 0);
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const result = await bridge.runMechanicalArgv("spec", []);

    expect(result?.success).toBe(true);
    expect(result?.validationErrors).toEqual([]);
  });
});

describe("the composite advances to the next task instead of ping-ponging", () => {
  /**
   * A stateful stub Kit reproducing the exact multi-task dead end a mid-tier
   * model hit live: T001 is finished, Kit's `next` says the next mechanical
   * step is `context T002` (while implementationAllowed stays true), and after
   * context runs, the policy gate names `verify` as the next allowed command.
   *
   * The old goal check fired on implementationAllowed alone, so `visp plan`
   * answered "done — run visp work" WITHOUT generating T002's context, `visp
   * work` then refused (no implement phase for T002), and status pointed back
   * at plan: an infinite loop with no exit on the thirteen-verb surface.
   */
  async function stubKitNextTask(): Promise<string> {
    await mkdir(join(tempDir, ".visp"), { recursive: true });
    await writeFile(join(tempDir, ".visp", "policy.json"), "{}", "utf8");
    const counterPath = join(tempDir, ".visp", "stub-context-ran");
    await writeShim(
      [
        'const fs = require("node:fs");',
        `const counter = ${JSON.stringify(counterPath)};`,
        "const sub = process.argv[2];",
        'if (sub === "status") {',
        '  process.stdout.write(JSON.stringify({ success: true, initialized: true }));',
        "  process.exit(0);",
        "}",
        'if (sub === "next") {',
        "  const contextRan = fs.existsSync(counter);",
        "  process.stdout.write(JSON.stringify({",
        "    success: true,",
        "    implementationAllowed: true,",
        '    nextCommand: contextRan ? "visp-kit verify --task T002" : "visp-kit context T002"',
        "  }));",
        "  process.exit(0);",
        "}",
        'if (sub === "context") {',
        '  fs.writeFileSync(counter, "ran");',
        '  process.stdout.write(JSON.stringify({ success: true }));',
        "  process.exit(0);",
        "}",
        'if (sub === "verify") {',
        '  fs.writeFileSync(counter + "-verify", "ran");',
        '  process.stdout.write(JSON.stringify({ success: false, errors: ["No source changes"] }));',
        "  process.exit(1);",
        "}",
        'process.stdout.write(JSON.stringify({ success: true }));',
        "process.exit(0);"
      ].join("\n")
    );
    return counterPath;
  }

  async function runPlan(): Promise<{ output: string; exitCode: number | undefined }> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    process.exitCode = undefined;

    const { Command } = await import("commander");
    const { planVerbCommand } = await import("../../../src/cli/commands/verbs.js");
    const program = new Command().option("--project <path>", "project", tempDir);
    program.addCommand(planVerbCommand());
    program.exitOverride();
    await program.parseAsync(["node", "visp", "plan"]);
    return { output: lines.join("\n"), exitCode: process.exitCode };
  }

  it("generates the next task's context before declaring implementation allowed", async () => {
    const counterPath = await stubKitNextTask();

    const { output, exitCode } = await runPlan();

    expect(output).toContain("→ visp-kit context T002");
    expect(output).toContain("implementation is allowed");
    expect(exitCode).toBeUndefined();
    const { readFile: read } = await import("node:fs/promises");
    await expect(read(counterPath, "utf8")).resolves.toBe("ran");
  });

  it("does not run verify on work that has not been written", async () => {
    const counterPath = await stubKitNextTask();

    await runPlan();

    // The policy gate names verify as "next allowed" the moment context
    // exists; executing it from the composite would judge an implementation
    // that does not exist yet.
    const { access } = await import("node:fs/promises");
    await expect(access(`${counterPath}-verify`)).rejects.toThrow();
  });
});

describe("visp check renders the findings a failing review already carries", () => {
  /** A stub Kit for the check verb: healthy status, verify passes, review fails. */
  async function stubKitCheck(): Promise<void> {
    await mkdir(join(tempDir, ".visp"), { recursive: true });
    await writeFile(join(tempDir, ".visp", "policy.json"), "{}", "utf8");
    const review = {
      success: false,
      findings: [
        { id: "REVIEW001", severity: "error", title: "Policy gate VSP012 did not pass" },
        { id: "REVIEW002", severity: "info", title: "Verification commands passed" }
      ]
    };
    await writeShim(
      [
        "const sub = process.argv[2];",
        'if (sub === "status") {',
        '  process.stdout.write(JSON.stringify({ success: true, initialized: true }));',
        "  process.exit(0);",
        "}",
        'if (sub === "verify") {',
        '  process.stdout.write(JSON.stringify({ success: true }));',
        "  process.exit(0);",
        "}",
        `process.stdout.write(${JSON.stringify(JSON.stringify(review))});`,
        "process.exit(1);"
      ].join("\n")
    );
  }

  async function runCheckVerb(): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    process.exitCode = undefined;

    const { Command } = await import("commander");
    const { checkVerbCommand } = await import("../../../src/cli/commands/verbs.js");
    const program = new Command().option("--project <path>", "project", tempDir);
    program.addCommand(checkVerbCommand());
    program.exitOverride();
    await program.parseAsync(["node", "visp", "check"]);

    return lines.join("\n");
  }

  // Observed live: a review failed because verify's scope check failed, Kit's
  // summary carried the findings, and `visp check` printed "(review reported
  // no detail; run visp-kit review for the full report)" — a second command
  // for information the first was holding. Same defect the block above pins
  // for the composites, one summary field further along.
  it("prints the failing findings instead of claiming there is no detail", async () => {
    await stubKitCheck();

    const output = await runCheckVerb();

    expect(output).toContain("Policy gate VSP012 did not pass");
    expect(output).not.toContain("reported no detail");
  });

  it("keeps info-severity findings out of the failure report", async () => {
    await stubKitCheck();

    const output = await runCheckVerb();

    expect(output).not.toContain("Verification commands passed");
  });
});

describe("a stage waiting on the human is not reported as a failure", () => {
  /** Drive `visp plan` against the stubbed Kit and capture what it printed. */
  async function runPlanVerb(): Promise<{ output: string; exitCode: number | undefined }> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    process.exitCode = undefined;

    const { Command } = await import("commander");
    const { planVerbCommand } = await import("../../../src/cli/commands/verbs.js");
    // `--project` is a GLOBAL option read via optsWithGlobals, so the verb has
    // to hang off a parent program exactly as it does in the real CLI.
    const program = new Command().option("--project <path>", "project", tempDir);
    program.addCommand(planVerbCommand());
    program.exitOverride();
    await program.parseAsync(["node", "visp", "plan"]);

    return { output: lines.join("\n"), exitCode: process.exitCode };
  }

  it("prints the validation errors instead of 'Run it directly for detail'", async () => {
    // `next` answers, then the executed stage fails validation.
    await stubKitWorkflow({
      success: false,
      validation: {
        errors: [
          "spec.userStories[0].title contains placeholder text.",
          "REQ001 must include at least one acceptance criterion."
        ]
      },
      feature: { path: ".visp/features/001-a-feature" }
    });

    const { output } = await runPlanVerb();

    expect(output).toContain("placeholder text");
    expect(
      output,
      "the composite still sent the user to a second command for information it was holding"
    ).not.toContain("Run it directly for detail");
  });

  it("names the artifact directory and the verb that resumes", async () => {
    await stubKitWorkflow({
      success: false,
      validation: { errors: ["REQ001 must include at least one acceptance criterion."] },
      feature: { path: ".visp/features/001-a-feature" }
    });

    const { output } = await runPlanVerb();

    expect(output).toContain(".visp/features/001-a-feature");
    expect(output, "the reader is not told how to continue").toContain("visp plan");
  });

  it("caps a long error list and says how many were elided", async () => {
    // A fresh spec produces 25. A wall of them is its own failure.
    const errors = Array.from({ length: 25 }, (_, index) => `error number ${index + 1}`);
    await stubKitWorkflow({ success: false, validation: { errors } });

    const { output } = await runPlanVerb();

    expect(output).toContain("error number 1");
    expect(output).not.toContain("error number 25");
    expect(output, "the elided count must be honest").toContain("(+20 more)");
  });

  it("exits 0, because needing a human is not a failure", async () => {
    await stubKitWorkflow({ success: false, validation: { errors: ["fill this in"] } });

    const { exitCode } = await runPlanVerb();

    expect(exitCode).toBeUndefined();
  });

  it("still fails hard when there are no validation errors, and offers Kit's recovery", async () => {
    // The converse. A genuine error must not be softened into "waiting on you".
    await stubKitWorkflow({
      success: false,
      recovery: 'visp-kit feature "<describe your feature>"'
    });

    const { output, exitCode } = await runPlanVerb();

    expect(output).toContain("visp-kit feature");
    expect(exitCode).toBe(1);
  });
});
