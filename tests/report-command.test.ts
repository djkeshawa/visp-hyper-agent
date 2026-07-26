import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createSession, initializeProject } from "../src/core/session-manager.js";
import type { TelemetryFile } from "../src/telemetry/telemetry-store.js";
import type { RoutingDecision, RoutingState } from "../src/routing/routing-state.js";
import { startMockMemoryServer, type MockMemoryServer } from "./helpers/mock-memory-server.js";

let logs: string[];
let server: MockMemoryServer | undefined;

beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await server.close();
    server = undefined;
  }
});

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-report-"));
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await initializeProject(projectPath);
  return projectPath;
}

async function writeTelemetry(projectPath: string, data: TelemetryFile): Promise<void> {
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(
    join(projectPath, ".visp", "hyper", "telemetry.json"),
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8"
  );
}

async function writeRouting(projectPath: string, state: RoutingState): Promise<void> {
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(
    join(projectPath, ".visp", "hyper", "routing.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function attempt(overrides: Partial<TelemetryFile["attempts"][number]>): TelemetryFile["attempts"][number] {
  const record: TelemetryFile["attempts"][number] = {
    taskId: "T001",
    taskClass: "bounded_feature",
    riskLevel: "medium",
    riskFactors: [],
    assuranceProfile: null,
    host: "codex",
    modelId: "implementer",
    modelVersion: null,
    projectPreset: "typescript",
    protocolVersion: "local-checked/1.0",
    kitVersion: "none",
    hyperVersion: "0.3.0",
    tier: "implementer",
    attempt: 1,
    verifyPassed: true,
    reviewPassed: true,
    verdict: "passed",
    evidenceSource: "local",
    firstAttempt: true,
    sessionId: "vh_seed",
    at: "2026-06-11T00:00:00.000Z",
    ...overrides
  };
  if (
    overrides.verdict === undefined &&
    (record.verifyPassed === false || record.reviewPassed === false)
  ) {
    record.verdict = "failed";
  }
  return record;
}

describe("report command (AC006)", () => {
  it("AC006a: aggregates telemetry + routing into a deterministic evidence view", async () => {
    const projectPath = await createProject();

    // Three sessions seeded for the sessionCount + quarantine cutoff.
    for (let i = 0; i < 3; i += 1) {
      await createSession({ projectPath, goal: `goal ${i}`, tool: "generic", relevantFiles: [] });
    }

    const telemetry: TelemetryFile = {
      attempts: [
        // implementer / bounded_feature / medium: 2 first-attempts, both pass → 100%
        attempt({
          taskId: "T001",
          tier: "implementer",
          taskClass: "bounded_feature",
          riskLevel: "medium",
          riskFactors: [{ version: "1.0", code: "public_api" }],
          firstAttempt: true,
          verifyPassed: true,
          reviewPassed: true
        }),
        attempt({
          taskId: "T002",
          tier: "implementer",
          taskClass: "bounded_feature",
          riskLevel: "medium",
          riskFactors: [{ version: "1.0", code: "public_api" }],
          firstAttempt: true,
          verifyPassed: true,
          reviewPassed: true
        }),
        // implementer / security / high: 2 first-attempts, one fails → 50%
        attempt({
          taskId: "T003",
          tier: "implementer",
          taskClass: "security",
          riskLevel: "high",
          riskFactors: [{ version: "1.0", code: "authorization" }],
          firstAttempt: true,
          verifyPassed: false,
          reviewPassed: true
        }),
        attempt({
          taskId: "T004",
          tier: "implementer",
          taskClass: "security",
          riskLevel: "high",
          riskFactors: [{ version: "1.0", code: "authorization" }],
          firstAttempt: true,
          verifyPassed: true,
          reviewPassed: true
        }),
        // scout / security / high: retry excluded from the first-attempt rate.
        attempt({
          taskId: "T003",
          tier: "scout",
          taskClass: "security",
          riskLevel: "high",
          riskFactors: [{ version: "1.0", code: "authorization" }],
          firstAttempt: false,
          attempt: 2,
          verifyPassed: true,
          reviewPassed: true
        }),
        attempt({
          taskId: "T005",
          tier: "scout",
          taskClass: "documentation",
          riskLevel: "low",
          riskFactors: [],
          firstAttempt: true,
          verifyPassed: true,
          reviewPassed: true
        }),
        // Inconclusive attempts remain visible but never enter the pass-rate denominator.
        attempt({
          taskId: "T006",
          tier: "implementer",
          taskClass: "documentation",
          riskLevel: "low",
          riskFactors: [],
          firstAttempt: true,
          verifyPassed: false,
          reviewPassed: false,
          verdict: "inconclusive"
        })
      ],
      usage: [
        { sessionId: "vh_seed", inputTokens: 1000, outputTokens: 200, at: "2026-06-11T00:00:00.000Z" },
        { sessionId: "vh_seed", inputTokens: 500, at: "2026-06-11T00:01:00.000Z" }
      ]
    };
    await writeTelemetry(projectPath, telemetry);

    const decisions = Array.from({ length: 12 }, (_, i) => ({
      taskId: `D${String(i).padStart(3, "0")}`,
      taskClass: "bounded_feature",
      riskLevel: "medium",
      riskFactors: [],
      tier: "implementer",
      reason: `decision ${i}`,
      at: "2026-06-11T00:00:00.000Z"
    })) satisfies RoutingDecision[];
    await writeRouting(projectPath, {
      quarantines: [
        { taskClass: "security", untilSessionCount: 5 }, // active (5 > 3)
        { taskClass: "documentation", untilSessionCount: 2 } // expired (2 <= 3)
      ],
      decisions
    });

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "report"]);
    const text = logs.join("\n");

    expect(text).toContain("BEGIN_VISP_HYPER_REPORT");
    expect(text).toContain("END_VISP_HYPER_REPORT");
    expect(text).toContain("sessions: 3");
    // 4 distinct first-attempt records: T001, T002, T003(first fail), T004, T005 pass → 4/5 first-attempts pass.
    // First-attempts: T001✓ T002✓ T003✗ T004✓ T005✓ → 4/5 = 80.0%
    expect(text).toContain("first_attempt_pass_rate: 80.0%");
    expect(text).toContain("inconclusive_attempts: 1");
    expect(text).toContain("tokens: input=1500 output=200");
    expect(text).toContain("implementer: attempts=5 inconclusive=1 pass_rate=75.0%");
    expect(text).toContain("scout: attempts=2 inconclusive=0 pass_rate=100.0%");
    expect(text).toContain("bounded_feature: attempts=2 inconclusive=0 pass_rate=100.0%");
    expect(text).toContain("security: attempts=3 inconclusive=0 pass_rate=50.0%");
    expect(text).toContain("per_risk_level:");
    expect(text).toContain("medium: attempts=2 inconclusive=0 pass_rate=100.0%");
    expect(text).toContain("high: attempts=3 inconclusive=0 pass_rate=50.0%");
    expect(text).toContain("per_risk_factor:");
    expect(text).toContain("public_api: attempts=2 inconclusive=0 pass_rate=100.0%");
    expect(text).toContain("authorization: attempts=3 inconclusive=0 pass_rate=50.0%");

    // Only the active quarantine appears.
    expect(text).toContain("security: until session 5");
    expect(text).not.toContain("documentation: until session 2");

    // Only the last 10 decisions appear (D002..D011), not D000/D001.
    expect(text).toContain("D011");
    expect(text).toContain("D002");
    expect(text).not.toContain("D000");
    expect(text).not.toContain("D001 ");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "report", "--json"]);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.totals.sessions).toBe(3);
    expect(parsed.totals.tasks).toBe(6);
    expect(parsed.totals.attempts).toBe(7);
    expect(parsed.totals.inconclusive).toBe(1);
    expect(parsed.totals.firstAttemptPassRate).toBeCloseTo(0.8);
    expect(parsed.tokens).toEqual({ inputTokens: 1500, outputTokens: 200 });
    expect(parsed.perClass.map((entry: { taskClass: string | null }) => entry.taskClass)).toEqual([
      "bounded_feature",
      "security",
      "documentation"
    ]);
    expect(parsed.perRiskLevel.map((entry: { riskLevel: string | null }) => entry.riskLevel)).toEqual([
      "medium",
      "high",
      "low"
    ]);
    expect(parsed.perRiskFactor.map((entry: { riskFactor: string }) => entry.riskFactor)).toEqual([
      "public_api",
      "authorization"
    ]);
    expect(parsed.quarantines).toEqual([{ taskClass: "security", untilSessionCount: 5 }]);
    expect(parsed.recentDecisions).toHaveLength(10);
    expect(parsed.recentDecisions[0].taskId).toBe("D002");
    expect(parsed.recentDecisions[9].taskId).toBe("D011");
  });

  it("counts feature-qualified work items independently when task IDs repeat", async () => {
    const projectPath = await createProject();
    await writeTelemetry(projectPath, {
      attempts: [
        attempt({
          featureId: "002",
          taskId: "T001",
          workItemKey: "002:T001",
          sessionId: "vh_feature_002"
        }),
        attempt({
          featureId: "003",
          taskId: "T001",
          workItemKey: "003:T001",
          sessionId: "vh_feature_003"
        })
      ],
      usage: []
    });

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "report", "--json"]);

    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.totals.tasks).toBe(2);
    expect(parsed.totals.attempts).toBe(2);
  });

  it("AC006b: empty project prints the frame with zeros and a no-telemetry note", async () => {
    const projectPath = await createProject();

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "report"]);
    const text = logs.join("\n");

    expect(text).toContain("BEGIN_VISP_HYPER_REPORT");
    expect(text).toContain("sessions: 0    tasks: 0    attempts: 0");
    expect(text).toContain("first_attempt_pass_rate: n/a");
    expect(text).toContain("tokens: input=0 output=0");
    expect(text).toContain("quarantines:\n  - none");
    expect(text).toContain("recent_routing_decisions:\n  - none");
    expect(text).toContain("note: no telemetry recorded yet.");
    expect(text).toContain("END_VISP_HYPER_REPORT");
  });
});

describe("remember distillation (AC007)", () => {
  async function startSession(projectPath: string): Promise<void> {
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement offline note sync"]);
  }

  async function writeConfig(projectPath: string, config: Record<string, unknown>): Promise<void> {
    await initializeProject(projectPath);
    await writeFile(
      join(projectPath, ".visp", "hyper", "config.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8"
    );
  }

  const baseConfig = {
    defaultTool: "generic",
    tokenBudget: 12000,
    contextMode: "deterministic",
    blockedPaths: [".git"]
  };

  it("posts session, decision, and follow-up memories to the remote provider", async () => {
    const projectPath = await createProject();
    server = await startMockMemoryServer({
      "GET /healthz": { json: { status: "ok" } },
      "POST /recall": { json: [] },
      "POST /memories": { json: { id: "saved", content: "x", layer: "episodic", category: "session" } }
    });
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "llm-memory", memoryEndpoint: server.url });
    await startSession(projectPath);

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "remember",
      "--summary",
      "s",
      "--decision",
      "use X",
      "--follow-up",
      "do Y"
    ]);

    const posts = server.requests.filter((r) => r.path === "/memories" && r.method === "POST");
    const session = posts.find((r) => (r.body as { category?: string }).category === "session");
    const decision = posts.find((r) => (r.body as { category?: string }).category === "architecture_decision");
    const followUp = posts.find((r) => (r.body as { category?: string }).category === "goal");

    expect(session?.body).toMatchObject({ content: "s", category: "session" });
    expect(decision?.body).toMatchObject({ category: "architecture_decision" });
    expect((decision?.body as { content: string }).content).toContain("use X");
    expect(followUp?.body).toMatchObject({ content: "do Y", layer: "intent", category: "goal" });
  });

  it("exits zero with warnings and still writes the file memory when the endpoint is closed", async () => {
    const closed = await startMockMemoryServer({});
    const url = closed.url;
    await closed.close();

    const projectPath = await createProject();
    // Use file mode for start so the closed endpoint only affects remember.
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", memoryEndpoint: url });
    await startSession(projectPath);
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "llm-memory", memoryEndpoint: url });

    await expect(
      runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "remember",
        "--summary",
        "s",
        "--decision",
        "use X",
        "--follow-up",
        "do Y"
      ])
    ).resolves.toBeUndefined();

    expect(logs.some((line) => line.includes("falling back to file memory"))).toBe(true);
    const memoryWritten = logs.some((line) => line.includes("Memory written to"));
    expect(memoryWritten).toBe(true);
  });
});
