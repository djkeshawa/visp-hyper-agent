import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createWorkflowActionV3Id } from "../src/kit/workflow-action-adapter.js";
import type { WorkflowActionV3Wire } from "../src/kit/workflow-action-protocol.js";
import { appendAttempt, readTelemetry } from "../src/telemetry/telemetry-store.js";
import type { TelemetryAttempt } from "../src/telemetry/telemetry-store.js";
import {
  CHEAP_TIER,
  STRONGEST_TIER,
  computeSuggestedTier,
  escalate
} from "../src/routing/routing-engine.js";
import type { RoutingState } from "../src/routing/routing-state.js";
import {
  authoritativeContextPackFixture,
  authoritativeTaskGraphFixture,
  createVispShim,
  gateResultFixture,
  policyValidateFixture,
  type ShimSpec
} from "./helpers/visp-shim.js";
import { toolOnlyPath } from "./helpers/tool-path.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";
const V2_HASH =
  "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6";
const V3_HASH =
  "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7";
const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });

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
    JSON.stringify(authoritativeTaskGraphFixture()),
    "utf8"
  );
  await writeFile(
    join(featureDir, "context", "T001.context.json"),
    JSON.stringify(authoritativeContextPackFixture()),
    "utf8"
  );
}

function kit20IntegrationContract(projectPath: string): Record<string, unknown> {
  return {
    success: true,
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.3" },
    targetPath: projectPath,
    initialized: true,
    activeFeature: {
      id: "001",
      slug: "pipeline",
      key: "001-pipeline",
      path: ".visp/features/001-pipeline"
    },
    activeTask: { id: "T001", title: "First task", status: "ready" },
    commands: {},
    capabilities: {
      contextGrounding: {
        artifactProvenance: true,
        orchestratorReadContract: true
      }
    },
    workflow: { freshnessChecks: ["contextPack.artifactProvenance[]"] },
    protocols: {
      workflowAction: {
        supported: ["2.0", "3.0"],
        default: "2.0",
        schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH }
      }
    },
    artifacts: {
      kitSignals: [".visp/policy.json", ".visp/project.json"],
      projectStatus: ".visp/status.json",
      projectProfile: ".visp/project.json",
      featureRoot: ".visp/features",
      featureDir: ".visp/features/001-pipeline",
      taskGraph: ".visp/features/001-pipeline/task-graph.json",
      contextPack: ".visp/features/001-pipeline/context/T001.context.json",
      contextPrompt: ".visp/features/001-pipeline/context/T001.prompt.md"
    },
    orchestrator: {
      readContractVersion: "0.1",
      requiredArtifacts: [
        {
          id: "task-graph",
          path: `.visp/features/${FEATURE_DIR}/task-graph.json`,
          role: "task-graph",
          mimeType: "application/json",
          requiredFor: ["handoff", "implementation", "checkpoint"],
          freshness: "hash-pinned"
        },
        {
          id: "context-pack",
          path: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
          role: "context-pack",
          mimeType: "application/json",
          requiredFor: ["handoff", "implementation", "checkpoint"],
          freshness: "hash-pinned"
        }
      ],
      freshnessPolicy: {
        contextPackHashPinned: true,
        provenanceArtifactsHashPinned: true,
        staleContextBlocks: ["implementation", "checkpoint", "pr"]
      }
    },
    warnings: []
  };
}

function kitStatusSpec(projectPath: string, extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        initialized: true,
        activeFeature: { id: "001", slug: "pipeline" },
        activeTask: { id: "T001", title: "First task", status: "ready" }
      }
    },
    integration: { stdout: kit20IntegrationContract(projectPath) },
    ...extra
  };
}

function allowedRunGates(projectPath: string): ShimSpec {
  return {
    "gate next": {
      stdout: gateResultFixture({ targetPath: projectPath, stage: "next" })
    },
    "gate implement": {
      stdout: gateResultFixture({ targetPath: projectPath, stage: "implement" })
    }
  };
}

async function canonicalRunAction(
  projectPath: string,
  overrides: Record<string, unknown> = {}
): Promise<WorkflowActionV3Wire> {
  const contextPath = `.visp/features/${FEATURE_DIR}/context/T001.context.json`;
  const taskGraphPath = `.visp/features/${FEATURE_DIR}/task-graph.json`;
  const [context, taskGraph] = await Promise.all([
    readFile(join(projectPath, contextPath), "utf8"),
    readFile(join(projectPath, taskGraphPath), "utf8")
  ]);
  const draft = {
    protocolVersion: "3.0" as const,
    canonicalVersion: "1.0" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    phase: "implement" as const,
    feature: { id: "001", slug: "pipeline" },
    task: {
      id: "T001",
      title: "First task",
      status: "ready" as const,
      dependsOn: [],
      parallelizable: false
    },
    taskClass: unavailable(),
    risk: { level: available("medium" as const), factors: unavailable() },
    assurance: {
      level: "kit_strict" as const,
      profile: unavailable(),
      workflowStrictness: available("strict" as const)
    },
    goal: "Canonical telemetry task",
    baseCommit: unavailable("not_captured"),
    requiredReads: [
      {
        id: "task-graph",
        role: "task_graph" as const,
        path: taskGraphPath,
        contentHash: `sha256:${createHash("sha256").update(taskGraph).digest("hex")}`,
        freshness: "content_hash" as const
      },
      {
        id: "task-context",
        role: "context_pack" as const,
        path: contextPath,
        contentHash: `sha256:${createHash("sha256").update(context).digest("hex")}`,
        freshness: "content_hash" as const
      }
    ],
    scope: {
      writablePaths: ["src/feature.ts"],
      expectedPaths: unavailable(),
      forbiddenPaths: [],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [],
    validationCommands: ["pnpm typecheck", "pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid" as const), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready" as const,
    nextCommand: "visp implement --task T001",
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  } as WorkflowActionV3Wire;
}

async function strictRunSpec(projectPath: string, extra: ShimSpec = {}): Promise<ShimSpec> {
  return kitStatusSpec(projectPath, {
    policy: { stdout: policyValidateFixture({ targetPath: projectPath }) },
    ...allowedRunGates(projectPath),
    next: { stdout: await canonicalRunAction(projectPath) },
    ...extra
  });
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

async function readTelemetryFile(projectPath: string): Promise<any> {
  return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "telemetry.json"), "utf8"));
}

async function startLocalQuick(projectPath: string, exitCode: number): Promise<void> {
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { test: `node -e "process.exit(${exitCode})"` }
    }),
    "utf8"
  );
  process.env.PATH = await toolOnlyPath(["git", "npm", "sh"]);
  await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
  await runCli([
    "node",
    "visp-hyper",
    "--project",
    projectPath,
    "quick",
    "local parser cleanup",
    "--tool",
    "codex"
  ]);
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
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("AC001a: appendAttempt computes attempt/firstAttempt and persists across reads", async () => {
    const projectPath = await createProject();

    const first = await appendAttempt(projectPath, {
      taskId: "T001",
      taskClass: "security",
      riskLevel: "high",
      riskFactors: [{ version: "1.0", code: "authorization" }],
      tier: "implementer",
      verifyPassed: true,
      reviewPassed: true,
      sessionId: "vh_test_1"
    });
    expect(first.attempt).toBe(1);
    expect(first.firstAttempt).toBe(true);

    const second = await appendAttempt(projectPath, {
      taskId: "T001",
      taskClass: "security",
      riskLevel: "high",
      riskFactors: [{ version: "1.0", code: "authorization" }],
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
    expect(data.attempts[1]).toMatchObject({
      taskClass: "security",
      riskLevel: "high",
      riskFactors: [{ version: "1.0", code: "authorization" }]
    });
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
      taskClass: null,
      riskLevel: null,
      riskFactors: [],
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

  it("migrates legacy risk-named classes without treating them as task-class evidence", async () => {
    const projectPath = await createProject();
    const telemetryPath = join(projectPath, ".visp", "hyper", "telemetry.json");
    await mkdir(dirname(telemetryPath), { recursive: true });
    await writeFile(
      telemetryPath,
      JSON.stringify({
        attempts: [
          {
            taskId: "T001",
            taskClass: "medium",
            tier: "scout",
            attempt: 1,
            verifyPassed: true,
            reviewPassed: true,
            firstAttempt: true,
            sessionId: "vh_legacy",
            at: "2026-07-11T00:00:00.000Z"
          }
        ],
        usage: []
      }),
      "utf8"
    );

    const { data } = await readTelemetry(projectPath);
    expect(data.attempts).toEqual([
      expect.objectContaining({
        taskClass: null,
        riskLevel: "medium",
        riskFactors: null
      })
    ]);

    const suggestion = computeSuggestedTier({
      task: {
        id: "T001",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        riskFactors: []
      },
      attempts: data.attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.evidence.samples).toBe(0);
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
  });

  it("AC001c: a local checkpoint keeps missing class separate from low risk", async () => {
    const projectPath = await createProject();
    await startLocalQuick(projectPath, 0);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "Q001"]);

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0].taskId).toBe("Q001");
    expect(telemetry.attempts[0].verifyPassed).toBe(true);
    expect(telemetry.attempts[0].reviewPassed).toBe(true);
    expect(telemetry.attempts[0].taskClass).toBeNull();
    expect(telemetry.attempts[0].riskLevel).toBe("low");
    expect(telemetry.attempts[0].riskFactors).toBeNull();
    expect(telemetry.attempts[0].tier).toBe("implementer");
    expect(telemetry.attempts[0].attempt).toBe(1);
    expect(telemetry.attempts[0].firstAttempt).toBe(true);
  });

  it("AC002a: remember with token flags records usage and forwards a kit budget call", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await strictRunSpec(projectPath, {
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
    const shim = await createVispShim(await strictRunSpec(projectPath));
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
    taskClass: "bounded_feature",
    riskLevel: "medium",
    riskFactors: [],
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
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts: [],
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.evidence.samples).toBe(0);
  });

  it("AC003b: low risk without evidence remains on strongest tier", () => {
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "localized_bug", riskLevel: "low", riskFactors: [] },
      attempts: [scoutAttempt({ taskClass: "localized_bug", riskLevel: "low" })],
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
  });

  it("AC003c: 30 passing scout first-attempts earn an experimental downgrade", () => {
    const attempts = Array.from({ length: 30 }, () => scoutAttempt());
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(CHEAP_TIER);
    expect(suggestion.reason).toContain("30 samples");
    expect(suggestion.evidence.passRate).toBe(1);
  });

  it("AC003c: 29 samples do not earn a downgrade", () => {
    const attempts = Array.from({ length: 29 }, () => scoutAttempt());
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("insufficient evidence");
    expect(suggestion.reason).toContain("29/30");
  });

  it("AC003c: 30 samples with one failure miss the Wilson threshold", () => {
    const attempts = Array.from({ length: 30 }, (_, index) =>
      scoutAttempt(index === 29 ? { verifyPassed: false } : {})
    );
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
      attempts,
      routingState: emptyRoutingState(),
      sessionCount: 0
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toContain("Wilson lower bound");
  });

  it("AC004a: escalate adds quarantine sessionCount+3 and a decision", () => {
    const next = escalate({
      state: emptyRoutingState(),
      taskId: "T001",
      taskClass: "bounded_feature",
      sessionCount: 5,
      now: "2026-06-11T00:00:00.000Z"
    });
    expect(next.quarantines).toEqual([{ taskClass: "bounded_feature", untilSessionCount: 8 }]);
    expect(next.decisions).toHaveLength(1);
    expect(next.decisions[0]?.tier).toBe(STRONGEST_TIER);
    expect(next.decisions[0]?.reason).toBe("checkpoint failure escalation");
  });

  it("AC004a: quality-first invariant: quarantine blocks downgrade despite perfect evidence", () => {
    const attempts = [scoutAttempt(), scoutAttempt(), scoutAttempt(), scoutAttempt(), scoutAttempt()];
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "bounded_feature", untilSessionCount: 8 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
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
    const attempts = Array.from({ length: 30 }, () => scoutAttempt());
    const routingState: RoutingState = {
      quarantines: [{ taskClass: "bounded_feature", untilSessionCount: 8 }],
      decisions: []
    };
    const suggestion = computeSuggestedTier({
      task: { id: "T001", taskClass: "bounded_feature", riskLevel: "medium", riskFactors: [] },
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
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  async function readRoutingFile(projectPath: string): Promise<any> {
    return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "routing.json"), "utf8"));
  }

  it("AC005a: run prints a model_routing block with a suggested tier", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const action = await canonicalRunAction(projectPath, {
      taskClass: available("bounded_feature"),
      risk: {
        level: available("medium"),
        factors: available([
          { version: "1.0", code: "public_api" },
          { version: "1.0", code: "schema" }
        ])
      }
    });

    const shim = await createVispShim(
      await strictRunSpec(projectPath, {
        next: { stdout: action },
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).toContain("suggested_tier:");
    // Strict routing binds only to the canonical class/risk/factors, not the
    // incompatible legacy graph risk.
    expect(output).toContain(`suggested_tier: ${STRONGEST_TIER}`);
    expect((await readRoutingFile(projectPath)).decisions.at(-1)).toMatchObject({
      taskId: "T001",
      taskClass: "bounded_feature",
      riskLevel: "medium",
      riskFactors: [
        { version: "1.0", code: "public_api" },
        { version: "1.0", code: "schema" }
      ]
    });
  });

  it("AC005a: unavailable canonical class stays null while explicit risk remains separate", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const action = await canonicalRunAction(projectPath, {
      taskClass: unavailable(),
      risk: { level: available("medium"), factors: available([]) }
    });
    const shim = await createVispShim(
      await strictRunSpec(projectPath, { next: { stdout: action } })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    expect(logs.join("\n")).toContain("BEGIN_VISP_MODEL_ROUTING");
    expect((await readRoutingFile(projectPath)).decisions.at(-1)).toMatchObject({
      taskId: "T001",
      taskClass: null,
      riskLevel: "medium",
      riskFactors: []
    });
  });

  it("AC005a: advisory routing failure cannot invalidate an authoritative session", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const routingPath = join(projectPath, ".visp", "hyper", "routing.json");
    await mkdir(routingPath, { recursive: true });
    const shim = await createVispShim(await strictRunSpec(projectPath));
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
    expect(output).not.toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(process.exitCode).toBeFalsy();
    const state = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    );
    expect(Object.keys(state.sessions)).toHaveLength(1);
    expect(state.sessions[state.activeSessionId]).toMatchObject({
      goal: "Canonical telemetry task",
      pipeline: { taskIds: ["T001"], currentTaskId: "T001" }
    });
    expect((await stat(routingPath)).isDirectory()).toBe(true);
  });

  it("AC005b: configured Kit failure preserves Hyper routing; a local failure quarantines its class", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await strictRunSpec(projectPath, {
        verify: { stdout: { success: false } },
        review: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
    const routingPath = join(projectPath, ".visp", "hyper", "routing.json");
    const routingBeforeCheckpoint = await readFile(routingPath, "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const kitOutput = logs.join("\n");

    expect(await readFile(routingPath, "utf8")).toBe(routingBeforeCheckpoint);
    expect((await readTelemetry(projectPath)).data.attempts).toEqual([]);
    expect(kitOutput).toContain("evidence_source: kit");
    expect(kitOutput).toContain("status: FAILED");
    expect(kitOutput).not.toContain("instruction:");
    expect(kitOutput).not.toContain("BEGIN_VISP_ADAPTATION");
    expect(kitOutput).not.toContain("BEGIN_VISP_TASK_ACTION");

    // Exercise local routing in a separate project that has never carried Kit
    // policy, project, feature, or context artifacts. Quick creates an explicit
    // synthetic local task. Its failed checkpoint owns an unclassified
    // quarantine while preserving low as the separate risk level.
    const localProjectPath = await createProject();
    await startLocalQuick(localProjectPath, 2);
    await runCli(["node", "visp-hyper", "--project", localProjectPath, "checkpoint", "--task", "Q001"]);
    const localRouting = await readRoutingFile(localProjectPath);
    expect(localRouting.quarantines).toHaveLength(1);
    expect(localRouting.quarantines[0].taskClass).toBeNull();

    logs = [];
    await runCli(["node", "visp-hyper", "--project", localProjectPath, "next"]);
    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).toContain(`suggested_tier: ${STRONGEST_TIER}`);
    expect(output).toContain("quarantined until session");
  });

  it("checkpoint --tier scout records tier scout in telemetry", async () => {
    const projectPath = await createProject();
    await startLocalQuick(projectPath, 0);
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "checkpoint",
      "--task",
      "Q001",
      "--tier",
      "scout"
    ]);

    const telemetry = await readTelemetryFile(projectPath);
    expect(telemetry.attempts).toHaveLength(1);
    expect(telemetry.attempts[0].tier).toBe("scout");
  });
});
