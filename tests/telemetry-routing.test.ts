import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { appendAttempt, readTelemetry } from "../src/telemetry/telemetry-store.js";
import type { TelemetryAttempt } from "../src/telemetry/telemetry-store.js";
import {
  CHEAP_TIER,
  STRONGEST_TIER,
  computeSuggestedTier,
  escalate
} from "../src/routing/routing-engine.js";
import type { RoutingState } from "../src/routing/routing-state.js";
import { createVispShim, type ShimSpec } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-telemetry-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  return projectPath;
}

async function writeTaskGraph(projectPath: string): Promise<void> {
  const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
  await mkdir(join(featureDir, "context"), { recursive: true });
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  await writeFile(
    join(featureDir, "task-graph.json"),
    JSON.stringify({
      featureId: "001",
      featureSlug: "pipeline",
      tasks: [
        {
          id: "T001",
          title: "First task",
          description: "Implement the first task",
          dependsOn: [],
          allowedFiles: ["src/feature.ts"],
          validationCommands: ["pnpm typecheck", "pnpm test"],
          riskLevel: "high",
          status: "ready"
        },
        {
          id: "T002",
          title: "Second task",
          dependsOn: ["T001"],
          allowedFiles: ["src/other.ts"]
        }
      ]
    }),
    "utf8"
  );
  await writeFile(
    join(featureDir, "context", "T001.context.json"),
    JSON.stringify({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "task target" }],
      validationCommands: ["pnpm typecheck", "pnpm test"]
    }),
    "utf8"
  );
}

function kitStatusSpec(extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        initialized: true,
        activeFeature: { id: "001", slug: "pipeline" },
        activeTask: { id: "T001", title: "First task", status: "ready" }
      }
    },
    ...extra
  };
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

async function readTelemetryFile(projectPath: string): Promise<any> {
  return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "telemetry.json"), "utf8"));
}

describe("telemetry store and budget round-trip", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  it("AC001a: appendAttempt computes attempt/firstAttempt and persists across reads", async () => {
    const projectPath = await createProject();

    const first = await appendAttempt(projectPath, {
      taskId: "T001",
      taskClass: "high",
      tier: "implementer",
      verifyPassed: true,
      reviewPassed: true,
      sessionId: "vh_test_1"
    });
    expect(first.attempt).toBe(1);
    expect(first.firstAttempt).toBe(true);

    const second = await appendAttempt(projectPath, {
      taskId: "T001",
      taskClass: "high",
      tier: "implementer",
      verifyPassed: false,
      reviewPassed: true,
      sessionId: "vh_test_1"
    });
    expect(second.attempt).toBe(2);
    expect(second.firstAttempt).toBe(false);

    const { data, warnings } = await readTelemetry(projectPath);
    expect(warnings).toEqual([]);
    expect(data.attempts).toHaveLength(2);
    expect(data.attempts[0]?.attempt).toBe(1);
    expect(data.attempts[1]?.attempt).toBe(2);
    expect(data.attempts[1]?.verifyPassed).toBe(false);
  });

  it("AC001b: corrupt telemetry.json yields empty + warning and append still works", async () => {
    const projectPath = await createProject();
    const telemetryPath = join(projectPath, ".visp", "hyper", "telemetry.json");
    await mkdir(dirname(telemetryPath), { recursive: true });
    await writeFile(telemetryPath, "not json at all {{{", "utf8");

    const result = await readTelemetry(projectPath);
    expect(result.data.attempts).toEqual([]);
    expect(result.data.usage).toEqual([]);
    expect(result.warnings.length).toBe(1);

    const record = await appendAttempt(projectPath, {
      taskId: "T001",
      taskClass: "unknown",
      tier: "implementer",
      verifyPassed: true,
      reviewPassed: true,
      sessionId: "vh_test_2"
    });
    expect(record.attempt).toBe(1);

    const after = await readTelemetry(projectPath);
    expect(after.warnings).toEqual([]);
    expect(after.data.attempts).toHaveLength(1);
  });

  it("AC001c: checkpoint --task records a telemetry attempt with verify + taskClass", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0].taskId).toBe("T001");
    expect(telemetry.attempts[0].verifyPassed).toBe(true);
    expect(telemetry.attempts[0].reviewPassed).toBe(true);
    expect(telemetry.attempts[0].taskClass).toBe("high");
    expect(telemetry.attempts[0].tier).toBe("implementer");
    expect(telemetry.attempts[0].attempt).toBe(1);
    expect(telemetry.attempts[0].firstAttempt).toBe(true);
  });

  it("AC002a: remember with token flags records usage and forwards a kit budget call", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        next: { stdout: { success: true, nextCommand: "visp implement" } },
        budget: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "remember",
      "--input-tokens",
      "1000",
      "--output-tokens",
      "200",
      "--model",
      "sonnet"
    ]);

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.usage).toHaveLength(1);
    expect(telemetry.usage[0].inputTokens).toBe(1000);
    expect(telemetry.usage[0].outputTokens).toBe(200);
    expect(telemetry.usage[0].model).toBe("sonnet");

    const argvLog = await readFile(shim.argvLogPath, "utf8");
    const budgetCalls = argvLog
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "budget");
    expect(budgetCalls).toHaveLength(1);
    expect(budgetCalls[0]).toContain("--record-usage");
    expect(budgetCalls[0]).toContain("--input-tokens");
    expect(budgetCalls[0]).toContain("1000");
  });

  it("AC002b: remember with token flags but no visp records usage and warns, exit zero", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    // First run a pipeline-aware session with a shim so the session has a task id...
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    // ...then drop visp from PATH for the remember call.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));

    logs = [];
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "remember",
      "--input-tokens",
      "500",
      "--model",
      "sonnet"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("visp kit unavailable for budget forwarding");

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.usage).toHaveLength(1);
    expect(telemetry.usage[0].inputTokens).toBe(500);
  });
});

function emptyRoutingState(): RoutingState {
  return { quarantines: [], decisions: [] };
}

function scoutAttempt(overrides: Partial<TelemetryAttempt> = {}): TelemetryAttempt {
  return {
    taskId: "T001",
    taskClass: "medium",
    tier: CHEAP_TIER,
    attempt: 1,
    verifyPassed: true,
    reviewPassed: true,
    firstAttempt: true,
    sessionId: "vh_test",
    at: new Date().toISOString(),
    ...overrides
  };
}

describe("routing engine (pure)", () => {
  it("AC003a: no evidence + medium risk → implementer with insufficient-evidence reason", () => {
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts: [],
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.evidence.samples).toBe(0);
  });

  it("AC003b: low risk → scout baseline", () => {
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "low" },
      attempts: [scoutAttempt({ taskClass: "low" })],
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toBe("baseline: low risk");
  });

  it("AC003c: 3 passing scout first-attempts → scout downgrade with evidence reason", () => {
    const attempts = [scoutAttempt(), scoutAttempt(), scoutAttempt()];
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toContain("3 samples");
    expect(suggestion.evidence.passRate).toBe(1);
  });

  it("AC003c: 2 samples → no downgrade (insufficient evidence)", () => {
    const attempts = [scoutAttempt(), scoutAttempt()];
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.reason).toContain("2/3");
  });

  it("AC003c: 3 samples at 66% pass → no downgrade (below 90%)", () => {
    const attempts = [
      scoutAttempt(),
      scoutAttempt(),
      scoutAttempt({ verifyPassed: false })
    ];
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("below 90%");
  });

  it("AC004a: escalate adds quarantine sessionCount+3 and a decision", () => {
    const next = escalate({
      state: emptyRoutingState(),
      taskId: "T001",
      taskClass: "medium",
      sessionCount: 5,
      now: "2026-06-11T00:00:00.000Z"
    });
    expect(next.quarantines).toEqual([{ taskClass: "medium", untilSessionCount: 8 }]);
    expect(next.decisions).toHaveLength(1);
    expect(next.decisions[0]?.tier).toBe(STRONGEST_TIER);
    expect(next.decisions[0]?.reason).toBe("checkpoint failure escalation");
  });

  it("AC004a: quality-first invariant: quarantine blocks downgrade despite perfect evidence", () => {
    const attempts = [scoutAttempt(), scoutAttempt(), scoutAttempt(), scoutAttempt(), scoutAttempt()];
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 8 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState,
      sessionCount: 5
    });
    // Perfect evidence exists, but an active quarantine forces the strongest tier.
    expect(suggestion.evidence.passRate).toBe(1);
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("quarantined until session 8");
  });

  it("AC004b: expired quarantine re-enables evidence-based downgrade", () => {
    const attempts = [scoutAttempt(), scoutAttempt(), scoutAttempt()];
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "medium", untilSessionCount: 8 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", riskLevel: "medium" },
      attempts,
      routingState,
      sessionCount: 8
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toContain("samples");
  });
});

describe("routing CLI integration", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  async function readRoutingFile(projectPath: string): Promise<any> {
    return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "routing.json"), "utf8"));
  }

  it("AC005a: run prints a model_routing block with a suggested tier", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).toContain("suggested_tier:");
    // T001 is high risk → strongest tier with no evidence.
    expect(output).toContain(`suggested_tier: ${STRONGEST_TIER}`);
  });

  it("AC005b: checkpoint failure quarantines class; later next shows implementer + quarantine reason", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        verify: { stdout: { success: false } },
        review: { stdout: { success: true } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const routing = await readRoutingFile(projectPath);
    expect(routing.quarantines).toHaveLength(1);
    expect(routing.quarantines[0].taskClass).toBe("high");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).toContain(`suggested_tier: ${STRONGEST_TIER}`);
    expect(output).toContain("quarantined until session");
  });

  it("checkpoint --tier scout records tier scout in telemetry", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "checkpoint",
      "--task",
      "T001",
      "--tier",
      "scout"
    ]);

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0].tier).toBe("scout");
  });
});
