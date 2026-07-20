import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import {
  authoritativeContextPackFixture,
  authoritativeTaskFixture,
  authoritativeTaskGraphFixture,
  createVispShim,
  gateResultFixture,
  policyValidateFixture as basePolicyValidateFixture,
  type ShimSpec
} from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";
const FEATURE_FILE_CONTENT = "export const value = 1;\n";

function policyValidateFixture(
  overrides: Parameters<typeof basePolicyValidateFixture>[0] = {}
) {
  return basePolicyValidateFixture({ targetPath: ".", ...overrides });
}

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-run-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), FEATURE_FILE_CONTENT, "utf8");
  await execFileAsync("git", ["init"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync("git", ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"], {
    cwd: projectPath
  });
  return projectPath;
}

type TaskGraphOptions = {
  provenance?: boolean;
  singleTask?: boolean;
  validationCommands?: string[];
};

function includedFeatureFileFixture(): Record<string, unknown> {
  return {
    path: "src/feature.ts",
    reason: "Authoritative task target.",
    includeMode: "full",
    hash: sha256(FEATURE_FILE_CONTENT),
    language: "TypeScript",
    sizeBytes: FEATURE_FILE_CONTENT.length,
    tokenEstimate: 8,
    summaryAvailable: true,
    snippetIncluded: false,
    summary: "Exports the feature fixture value."
  };
}

async function writeTaskGraph(projectPath: string, options: TaskGraphOptions = {}): Promise<void> {
  const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
  const includeProvenance = options.provenance ?? true;
  const firstTask = authoritativeTaskFixture({
    ...(options.validationCommands ? { validationCommands: options.validationCommands } : {})
  });
  const tasks = [
    firstTask,
    ...(options.singleTask
      ? []
      : [
          authoritativeTaskFixture({
            id: "T002",
            title: "Second task",
            description: "Implement the second task.",
            requirementIds: ["REQ002"],
            acceptanceCriterionIds: ["AC002"],
            dependsOn: ["T001"],
            allowedFiles: ["src/other.ts"],
            expectedFiles: ["tests/other.test.ts"],
            status: "pending"
          })
        ])
  ];
  await mkdir(join(featureDir, "context"), { recursive: true });
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const taskGraph = JSON.stringify(
    authoritativeTaskGraphFixture({
      tasks
    })
  );
  await writeFile(join(featureDir, "task-graph.json"), taskGraph, "utf8");
  await writeFile(
    join(featureDir, "context", "T001.context.json"),
    JSON.stringify(
      authoritativeContextPackFixture({
        selectedTask: firstTask,
        validationCommands: firstTask.validationCommands,
        includedFiles: [includedFeatureFileFixture()],
        artifactProvenance: includeProvenance
          ? [
              {
                label: "task graph",
                path: `.visp/features/${FEATURE_DIR}/task-graph.json`,
                hash: sha256(taskGraph),
                hashAlgorithm: "sha256"
              }
            ]
          : []
      })
    ),
    "utf8"
  );
  await writeTaskPrompts(projectPath);
}

async function writeTaskPrompts(projectPath: string, taskId = "T001"): Promise<void> {
  const featurePrompt = `.visp/features/${FEATURE_DIR}/context/${taskId}.prompt.md`;
  await mkdir(join(projectPath, ".visp", "prompts"), { recursive: true });
  await writeFile(
    join(projectPath, featurePrompt),
    `# Strict Visp Task Prompt\n\n- Selected task ID: ${taskId}\n`,
    "utf8"
  );
  await writeFile(
    join(projectPath, ".visp", "prompts", "current-task.prompt.md"),
    [
      "# Visp Task Implementation Prompt",
      "",
      `- Selected task ID: ${taskId}`,
      "",
      "Feature-specific prompt:",
      featurePrompt,
      ""
    ].join("\n"),
    "utf8"
  );
}

function integrationContractFixture(contractVersion = "2.0") {
  return {
    success: true,
    contractVersion,
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: ".",
    initialized: true,
    activeFeature: { id: "001", slug: "pipeline", key: FEATURE_DIR, path: `.visp/features/${FEATURE_DIR}` },
    activeTask: { id: "T001", title: "First task", status: "ready" },
    commands: {},
    capabilities: {
      governance: { failClosedGates: true, sourceEditsRequireImplementGate: true },
      contextGrounding: {
        taskScopedContextPacks: true,
        artifactProvenance: true,
        currentTaskPrompt: true,
        orchestratorReadContract: true
      },
      evidence: { verification: true, review: true, reconciliation: true }
    },
    workflow: {
      failClosedOn: ["policyValidate", "gateNext", "gateImplement"],
      freshnessChecks: ["contextPack.artifactProvenance[]"],
      implementationReadSet: [
        ".visp/features/<feature>/context/<task-id>.context.json",
        ".visp/prompts/current-task.prompt.md",
        ".visp/policy.json"
      ]
    },
    artifacts: {
      kitSignals: [".visp/policy.json", ".visp/project.json"],
      projectStatus: ".visp/status.json",
      projectProfile: ".visp/project.json",
      featureRoot: ".visp/features",
      featureDir: `.visp/features/${FEATURE_DIR}`,
      taskGraph: `.visp/features/${FEATURE_DIR}/task-graph.json`,
      contextPack: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
      contextPrompt: `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`
    },
    orchestrator: {
      readContractVersion: "0.1",
      requiredArtifacts: [
        {
          id: "context-pack",
          path: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
          role: "task context",
          mimeType: "application/json",
          requiredFor: ["implementation"],
          freshness: "hash-pinned"
        },
        {
          id: "context-prompt",
          path: `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`,
          role: "feature task prompt",
          mimeType: "text/markdown",
          requiredFor: ["implementation"],
          freshness: "read-latest"
        },
        {
          id: "current-task-prompt",
          path: ".visp/prompts/current-task.prompt.md",
          role: "current task prompt",
          mimeType: "text/markdown",
          requiredFor: ["implementation"],
          freshness: "read-latest"
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

function workflowActionFixture(protocolVersion = "2.0") {
  return {
    protocolVersion,
    phase: "implement",
    taskId: "T001",
    goal: "Implement the first task",
    requiredReads: [],
    writablePaths: ["src/feature.ts"],
    forbiddenPaths: [],
    acceptanceOracles: [],
    validationCommands: ["pnpm typecheck"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp implement"
  };
}

function reconcileSummaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    taskId: "T001",
    traceabilityUpdate: {
      requested: true,
      performed: true,
      updatedFiles: [`.visp/features/${FEATURE_DIR}/traceability.json`]
    },
    ...overrides
  };
}

function evidenceSummaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    taskId: "T001",
    ...overrides
  };
}

function kitStatusSpec(extra: ShimSpec = {}): ShimSpec {
  const spec: ShimSpec = {
    status: {
      stdout: {
        success: true,
        targetPath: ".",
        initialized: true,
        activeFeature: { id: "001", slug: "pipeline" },
        activeTask: { id: "T001", title: "First task", status: "ready" }
      }
    },
    integration: { stdout: integrationContractFixture() },
    ...extra
  };
  const statusResponse = spec.status;
  if (
    statusResponse &&
    typeof statusResponse.stdout === "object" &&
    !Array.isArray(statusResponse.stdout)
  ) {
    statusResponse.stdout = { targetPath: ".", ...statusResponse.stdout };
  }
  for (const stage of ["verify", "review"] as const) {
    const response = spec[stage];
    if (response && typeof response.stdout === "object" && !Array.isArray(response.stdout)) {
      response.stdout = { taskId: "T001", ...response.stdout };
    }
  }
  return spec;
}

function allowedRunGateSpec(): ShimSpec {
  return {
    "gate next": { stdout: gateResultFixture({ stage: "next", targetPath: "." }) },
    "gate implement": { stdout: gateResultFixture({ stage: "implement", targetPath: "." }) }
  };
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

async function readState(projectPath: string): Promise<any> {
  return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
}

async function readArgvLog(path: string): Promise<string[][]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

async function expectNoSession(projectPath: string): Promise<void> {
  const state = await readState(projectPath);
  expect.soft(state.activeSessionId).toBeNull();
  expect.soft(state.sessions).toEqual({});
  await expect
    .soft(readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8"))
    .rejects.toMatchObject({ code: "ENOENT" });
}

function expectNoLocalFallthrough(output: string): void {
  expect.soft(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
  expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");
  expect.soft(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
  expect.soft(output).not.toContain("BEGIN_VISP_NEXT_ACTION");
  expect.soft(output).not.toContain("BEGIN_VISP_MODEL_ROUTING");
}

function recoveryCommandLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:next|next_command|next_allowed_command)\s*:/u.test(line));
}

function expectNoInventedRecovery(output: string): void {
  expect.soft(recoveryCommandLines(output)).toEqual([]);
}

async function createStrictSession(projectPath: string, options: TaskGraphOptions = {}): Promise<void> {
  await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
  await writeTaskGraph(projectPath, options);
  const shim = await createVispShim(
    kitStatusSpec({
      policy: { stdout: policyValidateFixture() },
      ...allowedRunGateSpec()
    })
  );
  prependToPath(dirname(shim.binary));
  await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);
}

function activePipeline(state: any): any {
  return state.sessions[state.activeSessionId].pipeline;
}

describe("run command and pipeline-aware next/checkpoint", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  it("AC006: kit-less run mirrors start (handoff printed, current files written)", async () => {
    const projectPath = await createProject();
    const emptyDir = await mkdtemp(join(tmpdir(), "visp-empty-"));
    process.env.PATH = emptyDir;

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement feature", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");

    const session = await readFile(join(projectPath, ".visp", "hyper", "current", "session.md"), "utf8");
    expect(session).toContain("implement feature");
    await readFile(join(projectPath, ".visp", "hyper", "current", "context-pack.md"), "utf8");
    await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8");
  });

  it("FAIL_CLOSED: configured project with a missing Kit binary never enters local run", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: binary_not_found");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
  });

  it("FAIL_CLOSED: success false status never enters local or strict run", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        status: {
          stdout: {
            success: false,
            initialized: true,
            activeFeature: { id: "001", slug: "pipeline" },
            activeTask: { id: "T001", title: "First task", status: "ready" }
          }
        },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: status_failed");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv[0]).toEqual(["status", "--json"]);
    expect.soft(argv.some((args) => args[0] === "integration")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "policy")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
  });

  it("FAIL_CLOSED: configured-unhealthy next cannot reuse an existing local session", async () => {
    const projectPath = await createProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "local session", "--tool", "codex"]);
    await writeTaskGraph(projectPath);
    const stateBefore = await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8");
    const handoffBefore = await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: binary_not_found");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).toBe(stateBefore);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")).toBe(handoffBefore);
  });

  it("FAIL_CLOSED: unsupported integration contract blocks run before policy, gates, or session", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: integrationContractFixture("1.3") },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: unsupported_integration_contract");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.slice(0, 2)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"]
    ]);
    expect.soft(argv.some((args) => args[0] === "policy")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
  });

  it("FAIL_CLOSED: an uninitialized integration contract blocks before policy or gates", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        integration: {
          stdout: { ...integrationContractFixture(), initialized: false }
        },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("initialized=false");
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.map((args) => args[0])).toEqual(["status", "integration"]);
  });

  it("FAIL_CLOSED: integration contract 2.0 with success false blocks before policy, gates, or session", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: { ...integrationContractFixture(), success: false } },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: integration_contract_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"]
    ]);
  });

  it.each([
    { label: "missing", policy: undefined },
    { label: "malformed", policy: { stdout: "not policy json" } },
    {
      label: "valid-JSON wrong-shape",
      policy: { stdout: { success: true, errors: [7] } }
    },
    {
      label: "success-validation coherence mismatch",
      policy: {
        stdout: policyValidateFixture({
          success: true,
          validation: {
            passed: false,
            errors: ["The nested Kit validation result is authoritative."]
          }
        })
      }
    }
  ])("FAIL_CLOSED: $label policy result blocks before gate or session", async ({ policy }) => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const spec = kitStatusSpec({ ...allowedRunGateSpec() });
    if (policy) {
      spec.policy = policy;
    }
    const shim = await createVispShim(spec);
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: policy_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.slice(0, 3)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["policy", "validate", "--json"]
    ]);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
  });

  it.each([
    { label: "missing", gate: undefined, status: "INCONCLUSIVE", reasonCode: "gate_next_unavailable" },
    {
      label: "malformed",
      gate: { stdout: "not gate json" },
      status: "INCONCLUSIVE",
      reasonCode: "gate_next_unavailable"
    },
    {
      label: "blocked",
      gate: {
        stdout: gateResultFixture({
          stage: "next",
          targetPath: ".",
          allowed: false,
          failedRules: [{ ruleId: "VSP014", message: "Implementation is not allowed" }],
          nextAllowedCommand: "Run visp tasks.",
          nextCommand: "visp tasks"
        }),
        exitCode: 1
      },
      status: "BLOCKED",
      reasonCode: "gate_next_blocked"
    }
  ])(
    "FAIL_CLOSED: $label gate next stops before implement evaluation or session",
    async ({ gate, status, reasonCode }) => {
      const projectPath = await createProject();
      await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
      await writeTaskGraph(projectPath);
      const spec = kitStatusSpec({ policy: { stdout: policyValidateFixture() } });
      if (gate) {
        spec.gate = gate;
      }
      const shim = await createVispShim(spec);
      prependToPath(dirname(shim.binary));

      logs = [];
      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

      const output = logs.join("\n");
      expect.soft(output).toContain(`status: ${status}`);
      expect.soft(output).toContain(`reason_code: ${reasonCode}`);
      expectNoLocalFallthrough(output);
      if (status === "INCONCLUSIVE") {
        expectNoInventedRecovery(output);
      } else {
        expect.soft(recoveryCommandLines(output)).toEqual(["next_allowed_command: visp tasks"]);
        expect.soft(output).not.toContain("instruction:");
      }
      await expectNoSession(projectPath);
      const argv = await readArgvLog(shim.argvLogPath);
      expect.soft(argv.slice(0, 4)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        ["policy", "validate", "--json"],
        ["gate", "next", "--json"]
      ]);
      expect.soft(
        argv.some((args) => args[0] === "gate" && args[1] === "implement")
      ).toBe(false);
    }
  );

  it("FAIL_CLOSED: missing configured task graph stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_graph_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.map((args) => args.slice(0, 2))).toEqual([
      ["status", "--json"],
      ["integration", "contract"],
      ["policy", "validate"],
      ["gate", "next"]
    ]);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: valid JSON with the wrong task-graph shape stops before context or implement gate", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "task-graph.json"),
      JSON.stringify({ featureId: "001", featureSlug: "pipeline", tasks: [] }),
      "utf8"
    );
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_graph_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: task graph without an executable task stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "task-graph.json"),
      JSON.stringify(authoritativeTaskGraphFixture({ tasks: [] })),
      "utf8"
    );
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: feature disagreement stops before context adoption or implement gate", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const contract = integrationContractFixture();
    contract.activeFeature = {
      id: "001",
      slug: "other",
      key: "001-other",
      path: ".visp/features/001-other"
    };
    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: contract },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("reason_code: task_context_mismatch");
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: graph and context task scheduling metadata must agree exactly", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const contextPath = join(
      projectPath,
      ".visp",
      "features",
      FEATURE_DIR,
      "context",
      "T001.context.json"
    );
    const pack = JSON.parse(await readFile(contextPath, "utf8")) as {
      selectedTask: { riskLevel: string };
    };
    pack.selectedTask.riskLevel = "low";
    await writeFile(contextPath, JSON.stringify(pack), "utf8");
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    expect.soft(logs.join("\n")).toContain("reason_code: task_context_mismatch");
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: missing context pack stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    await rm(join(projectPath, ".visp", "features", FEATURE_DIR, "context", "T001.context.json"));
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: context_pack_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);
  });

  it.each([
    { label: "missing", content: null },
    { label: "blank", content: "   \n" },
    {
      label: "wrong-task",
      content: [
        "# Visp Task Implementation Prompt",
        "",
        "- Selected task ID: T999",
        "",
        "Feature-specific prompt:",
        `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`,
        ""
      ].join("\n")
    },
    {
      label: "conflicting-task",
      content: [
        "# Visp Task Implementation Prompt",
        "",
        "- Selected task ID: T001",
        "- Selected task ID: T999",
        "",
        "Feature-specific prompt:",
        `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`,
        ""
      ].join("\n")
    },
    {
      label: "misleading-feature-pointer",
      content: [
        "# Visp Task Implementation Prompt",
        "",
        "- Selected task ID: T001",
        "",
        `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`,
        "",
        "Feature-specific prompt:",
        ".visp/features/999-other/context/T001.prompt.md",
        ""
      ].join("\n")
    }
  ])("FAIL_CLOSED: $label current task prompt stops run before implement gate", async ({ content }) => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    const promptPath = join(projectPath, ".visp", "prompts", "current-task.prompt.md");
    if (content === null) {
      await rm(promptPath);
    } else {
      await writeFile(promptPath, content, "utf8");
    }
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    expect.soft(logs.join("\n")).toContain("reason_code: context_pack_unavailable");
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: valid JSON with the wrong context-pack shape stops before implement gate", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "context", "T001.context.json"),
      JSON.stringify({
        taskId: "T001",
        includedFiles: [{ path: "src/feature.ts", reason: "legacy partial context" }]
      }),
      "utf8"
    );
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: context_pack_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: an authoritative context pack with only blocked files stops before implement gate", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "context", "T001.context.json"),
      JSON.stringify(
        authoritativeContextPackFixture({
          includedFiles: [
            {
              path: ".env",
              reason: "Must be rejected by Hyper's configured blocked paths.",
              includeMode: "full",
              hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              language: "dotenv",
              sizeBytes: 16,
              tokenEstimate: 4,
              summaryAvailable: false,
              snippetIncluded: false
            }
          ]
        })
      ),
      "utf8"
    );
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: context_pack_unavailable");
    expect.soft(output).toContain("yielded no usable, policy-allowed files");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it.each([
    { label: "missing", next: undefined, reasonCode: "strict_next_unavailable" },
    { label: "malformed", next: { stdout: "not workflow action json" }, reasonCode: "strict_next_unavailable" },
    {
      label: "unsupported",
      next: { stdout: workflowActionFixture("3.0") },
      reasonCode: "unsupported_workflow_action"
    },
    {
      label: "nonzero ready",
      next: { stdout: workflowActionFixture(), exitCode: 1 },
      reasonCode: "strict_next_unavailable"
    }
  ])("FAIL_CLOSED: $label strict next action cannot fall through locally", async ({ next, reasonCode }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const stateBefore = await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8");
    const handoffBefore = await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8");
    const spec = kitStatusSpec();
    if (next) {
      spec.next = next;
    }
    const shim = await createVispShim(spec);
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain(`reason_code: ${reasonCode}`);
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).toBe(stateBefore);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")).toBe(handoffBefore);
  });

  it("AC004: kit run with allowed gate prints handoff plus task action and sets pipeline", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).toContain("task: T001");
    expect(output).toContain("allowed_files:");
    expect(output).toContain("src/feature.ts");
    expect(output).toContain("validation_commands:");
    expect(output).toContain("pnpm typecheck");
    expect(output).toContain(`context_pack: ${join(".visp", "features", FEATURE_DIR, "context", "T001.context.json")}`);

    const pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T001");
    // A sequential graph prints no fan-out directive.
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["policy", "validate", "--json"],
      ["gate", "next", "--json"],
      ["gate", "implement", "--task", "T001", "--json"]
    ]);
    expect.soft(argv.filter((args) => args[0] === "status")).toHaveLength(1);
    expect.soft(argv.filter((args) => args[0] === "integration")).toHaveLength(1);
  });

  it("prints a workflow directive when the graph has parallelizable disjoint tasks", async () => {
    const projectPath = await createProject();
    const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
    const firstTask = authoritativeTaskFixture({ parallelizable: true });
    await mkdir(join(featureDir, "context"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await writeFile(
      join(featureDir, "task-graph.json"),
      JSON.stringify(
        authoritativeTaskGraphFixture({
          tasks: [
            firstTask,
            authoritativeTaskFixture({
              id: "T002",
              title: "Second task",
              description: "Implement the independent second task.",
              requirementIds: ["REQ002"],
              acceptanceCriterionIds: ["AC002"],
              dependsOn: [],
              allowedFiles: ["src/other.ts"],
              expectedFiles: ["tests/other.test.ts"],
              status: "ready",
              parallelizable: true
            }),
            authoritativeTaskFixture({
              id: "T003",
              title: "Third task",
              description: "Integrate the first two tasks.",
              requirementIds: ["REQ003"],
              acceptanceCriterionIds: ["AC003"],
              dependsOn: ["T001", "T002"],
              allowedFiles: ["src/integration.ts"],
              expectedFiles: ["tests/integration.test.ts"],
              status: "pending"
            })
          ]
        })
      ),
      "utf8"
    );
    await writeFile(
      join(featureDir, "context", "T001.context.json"),
      JSON.stringify(
        authoritativeContextPackFixture({
          selectedTask: firstTask,
          includedFiles: [includedFeatureFileFixture()]
        })
      ),
      "utf8"
    );
    await writeTaskPrompts(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement", "--tool", "claude-code"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    expect(output).toContain("1. parallel: T001, T002 (disjoint file scopes, parallelizable)");
    expect(output).toContain("2. sequential: T003");
    expect(output).toContain("subagent via the Task tool");
    expect(output).toContain("END_VISP_WORKFLOW_DIRECTIVE");
  });

  it("warns when strict Kit mode uses a contract without provenance freshness", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const contract = integrationContractFixture();
    contract.capabilities.contextGrounding.artifactProvenance = false;
    contract.workflow.freshnessChecks = [
      `.visp/features/<feature>/context/<task-id>.context.json`
    ];

    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: contract },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("warning: Kit integration contract 2.0 does not advertise provenance freshness");
    expect(output).toContain("BEGIN_VISP_TASK_ACTION");
  });

  it("FAIL_CLOSED: checkpoint fails when Kit provenance changes after handoff", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "task-graph.json"),
      JSON.stringify({
        featureId: "001",
        featureSlug: "pipeline",
        tasks: [
          {
            id: "T001",
            title: "First task changed",
            description: "Changed after handoff",
            dependsOn: [],
            allowedFiles: ["src/feature.ts"],
            validationCommands: ["pnpm typecheck", "pnpm test"],
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

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect(output).toContain("context_freshness: stale");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("context provenance changed since handoff");
    expect(output).toContain("task graph");

    const pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T001");
    const argv = await readArgvLog(shim.argvLogPath);
    expect(argv.some((args) => args[0] === "reconcile")).toBe(false);
  });

  it("checkpoint carries freshness warnings for context packs without provenance", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath, { provenance: false });

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect(output).toContain("context_freshness: current");
    expect(output).toContain("warnings:");
    expect(output).toContain("has no artifactProvenance");
    expect(output).toContain("checkpoint can pin only the context-pack file");
  });

  it("AC005: blocked implement gate prints PIPELINE_BLOCKED without creating a session", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        "gate next": { stdout: gateResultFixture({ stage: "next", targetPath: "." }) },
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
            targetPath: ".",
            allowed: false,
            failedRules: [{ ruleId: "R-IMPL-001", message: "Spec not approved" }],
            nextAllowedCommand: "Run visp specify.",
            nextCommand: "visp specify"
          }),
          exitCode: 1
        }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("R-IMPL-001");
    expect.soft(recoveryCommandLines(output)).toEqual(["next_allowed_command: visp specify"]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectNoSession(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);

    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("blocked implement gate uses only the bare Kit nextCommand", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        "gate next": { stdout: gateResultFixture({ stage: "next", targetPath: "." }) },
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
            targetPath: ".",
            allowed: false,
            failedRules: [{ ruleId: "R-IMPL-002", message: "Feature not started" }],
            // Sentence form (would make a weak model execute the word "Run") plus
            // the bare machine-runnable form the run command must prefer.
            nextAllowedCommand: 'Run visp feature "<describe your feature>".',
            nextCommand: 'visp feature "<describe your feature>"'
          }),
          exitCode: 1
        }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    // Prefers the bare command, not the sentence.
    expect(output).toContain('next_allowed_command: visp feature "<describe your feature>"');
    expect(output).not.toContain("next_allowed_command: Run visp feature");
    // Hyper must render only Kit's machine command; it must not invent a
    // follow-up instruction around the authoritative recovery action.
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectNoSession(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);
  });

  it("blocked implement gate does not substitute Kit nextAllowedCommand when nextCommand is absent", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        "gate next": { stdout: gateResultFixture({ stage: "next", targetPath: "." }) },
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
            targetPath: ".",
            allowed: false,
            failedRules: [{ ruleId: "R-IMPL-003", message: "Kit has no machine recovery command" }],
            nextAllowedCommand: "Run a human-oriented recovery sequence.",
            nextCommand: undefined
          }),
          exitCode: 1
        }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("R-IMPL-003");
    expect.soft(recoveryCommandLines(output)).toEqual([]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectNoSession(projectPath);
  });

  it("AC007: strict next renders WorkflowAction 2.0 while genuine no-Kit next stays local", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: workflowActionFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    let output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_WORKFLOW_ACTION_V2");
    expect(output).toContain('"protocolVersion":"2.0"');
    expect(output).toContain('"assuranceLevel":"kit_strict"');
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");

    // A separate project with no Kit signals retains explicitly local behavior.
    const localProjectPath = await createProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    logs = [];
    await runCli(["node", "visp-hyper", "--project", localProjectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", localProjectPath, "start", "plain goal", "--tool", "codex"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", localProjectPath, "next"]);
    output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_NEXT_ACTION");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).toContain("read .visp/hyper/current/agent-instructions.md");
  });

  it("POLICY_BLOCKED: failing policy validate stops before any handoff or kit artifacts", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const nextCommand = "Fix .visp/policy.json and run `visp policy validate`.";

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: {
          stdout: policyValidateFixture({
            success: false,
            validation: {
              passed: false,
              errors: ["Policy file references missing rule R-XYZ-001"]
            },
            nextCommand
          }),
          exitCode: 1
        },
        // These would let the run proceed; they must never be reached.
        ...allowedRunGateSpec(),
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_POLICY_BLOCKED");
    expect(output).toContain("Policy file references missing rule R-XYZ-001");
    expect.soft(recoveryCommandLines(output)).toEqual([`next_allowed_command: ${nextCommand}`]);
    expect(output).not.toContain("instruction:");
    // The run returns early: no handoff, no task action, no pipeline-blocked block.
    expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    await expectNoSession(projectPath);

    // No kit artifacts authored when policy is blocked.
    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("POLICY_BLOCKED: non-empty nested Kit errors block even when success and passed are true", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const nextCommand = "visp policy validate";
    const shim = await createVispShim(
      kitStatusSpec({
        policy: {
          stdout: policyValidateFixture({
            success: true,
            validation: {
              passed: true,
              errors: ["Kit reported a policy error despite a successful validation flag."]
            },
            nextCommand
          })
        },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_POLICY_BLOCKED");
    expect(output).toContain("Kit reported a policy error despite a successful validation flag.");
    expect.soft(recoveryCommandLines(output)).toEqual([`next_allowed_command: ${nextCommand}`]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectNoSession(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["policy", "validate", "--json"]
    ]);
  });

  it.each([
    { label: "missing", implementGate: undefined },
    {
      label: "malformed",
      implementGate: { stdout: "not json at all — the gate crashed mid-output" }
    }
  ])("FAIL_CLOSED: $label implement gate stops before session creation", async ({ implementGate }) => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const spec = kitStatusSpec({
      policy: { stdout: policyValidateFixture() },
      "gate next": { stdout: gateResultFixture({ stage: "next", targetPath: "." }) }
    });
    if (implementGate) {
      spec["gate implement"] = implementGate;
    }
    const shim = await createVispShim(spec);
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: gate_implement_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectNoSession(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(false);
  });

  it("FAIL_CLOSED: checkpoint fails when the adopted Kit context artifact changed after handoff", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "context", "T001.context.json"),
      JSON.stringify({
        taskId: "T001",
        includedFiles: [{ path: "src/feature.ts", reason: "updated task target" }],
        validationCommands: ["pnpm typecheck", "pnpm test", "pnpm lint"]
      }),
      "utf8"
    );

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect(output).toContain("context_freshness: stale");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("context artifact changed since handoff");

    const pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T001");
    const argv = await readArgvLog(shim.argvLogPath);
    expect(argv.some((args) => args[0] === "reconcile")).toBe(false);
  });

  it("FAIL_CLOSED: configured-unhealthy checkpoint never invokes local evidence or mutates strict state", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath, { validationCommands: ["visp evidence-probe"] });
    const pipelineBefore = activePipeline(await readState(projectPath));

    const unhealthyShim = await createVispShim({
      status: {
        stdout: {
          success: false,
          targetPath: ".",
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: { id: "T001", title: "First task", status: "ready" }
        }
      },
      "evidence-probe": { stdout: "local evidence executed" }
    });
    prependToPath(dirname(unhealthyShim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: status_failed");
    expect.soft(output).not.toContain("evidence_source: local");
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");

    const argv = await readArgvLog(unhealthyShim.argvLogPath);
    expect.soft(argv).toContainEqual(["status", "--json"]);
    expect.soft(argv.some((args) => args[0] === "evidence-probe")).toBe(false);

    const pipelineAfter = activePipeline(await readState(projectPath));
    expect.soft(pipelineAfter.currentTaskId).toBe(pipelineBefore.currentTaskId);
    expect.soft(pipelineAfter.completed).toEqual(pipelineBefore.completed);
    expect.soft(pipelineAfter.injectedTasks ?? []).toEqual(pipelineBefore.injectedTasks ?? []);
    expect.soft(pipelineAfter.decisionLog ?? []).toEqual(pipelineBefore.decisionLog ?? []);
    const addedSteps = pipelineAfter.stepHistory.slice(pipelineBefore.stepHistory.length);
    expect.soft(
      addedSteps.some(
        (step: any) =>
          step.detail === "local-evidence" ||
          step.action === "checkpoint-passed" ||
          step.action === "checkpoint-failed"
      )
    ).toBe(false);
  });

  it("FAIL_CLOSED: checkpoint revalidates the live feature identity before evidence", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const pipelineBefore = activePipeline(await readState(projectPath));
    const switchedFeature = "002-other";
    const contract = integrationContractFixture();
    contract.activeFeature = {
      id: "002",
      slug: "other",
      key: switchedFeature,
      path: `.visp/features/${switchedFeature}`
    };
    contract.artifacts.featureDir = `.visp/features/${switchedFeature}`;
    contract.artifacts.taskGraph = `.visp/features/${switchedFeature}/task-graph.json`;
    contract.artifacts.contextPack = `.visp/features/${switchedFeature}/context/T001.context.json`;
    contract.artifacts.contextPrompt = `.visp/features/${switchedFeature}/context/T001.prompt.md`;
    contract.orchestrator.requiredArtifacts = contract.orchestrator.requiredArtifacts.map((artifact) => ({
      ...artifact,
      path:
        artifact.id === "context-pack"
          ? contract.artifacts.contextPack
          : artifact.id === "context-prompt"
            ? contract.artifacts.contextPrompt
            : artifact.path
    }));
    const shim = await createVispShim(
      kitStatusSpec({
        status: {
          stdout: {
            success: true,
            initialized: true,
            activeFeature: { id: "002", slug: "other" },
            activeTask: { id: "T001", title: "First task", status: "ready" }
          }
        },
        integration: { stdout: contract },
        verify: { stdout: evidenceSummaryFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toContain("live Kit feature or context identity changed for T001");
    expect.soft((await readArgvLog(shim.argvLogPath)).map((args) => args[0])).toEqual([
      "status",
      "integration"
    ]);
    const pipelineAfter = activePipeline(await readState(projectPath));
    expect.soft(pipelineAfter.currentTaskId).toBe(pipelineBefore.currentTaskId);
    expect.soft(pipelineAfter.completed).toEqual(pipelineBefore.completed);
  });

  it("FAIL_CLOSED: checkpoint detects a role-only live read-contract change", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const contract = integrationContractFixture();
    contract.orchestrator.requiredArtifacts[0]!.role = "untrusted replacement role";
    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: contract },
        verify: { stdout: evidenceSummaryFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toContain("live Kit context-pack declaration changed since the strict handoff");
    expect.soft((await readArgvLog(shim.argvLogPath)).map((args) => args[0])).toEqual([
      "status",
      "integration"
    ]);
  });

  it("FAIL_CLOSED: checkpoint compares selected files with the pinned context pack", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const manifestPath = join(
      projectPath,
      ".visp",
      "hyper",
      "current",
      "context-manifest.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      selectedFiles: Array<Record<string, unknown>>;
    };
    manifest.selectedFiles = [
      {
        path: "src/unrelated.ts",
        reason: "tampered manifest entry",
        hasContent: true
      }
    ];
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    const shim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: evidenceSummaryFixture() },
        review: { stdout: evidenceSummaryFixture() },
        reconcile: { stdout: reconcileSummaryFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toContain(
      "strict Kit context manifest selected files do not exactly match the context pack for T001"
    );
    expect.soft((await readArgvLog(shim.argvLogPath)).map((args) => args[0])).toEqual([
      "status",
      "integration"
    ]);
  });

  it("supports an exact non-empty run-to-checkpoint handoff for a planned new file", async () => {
    const projectPath = await createProject();
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
    const plannedTask = authoritativeTaskFixture({
      allowedFiles: ["generated/new-feature.ts"],
      expectedFiles: ["tests/new-feature.test.ts"]
    });
    const graphText = JSON.stringify(
      authoritativeTaskGraphFixture({ tasks: [plannedTask] })
    );
    await mkdir(join(featureDir, "context"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await writeFile(join(featureDir, "task-graph.json"), graphText, "utf8");
    await writeFile(
      join(featureDir, "context", "T001.context.json"),
      JSON.stringify(
        authoritativeContextPackFixture({
          selectedTask: plannedTask,
          includedFiles: [
            {
              path: "generated/new-feature.ts",
              reason: "planned task output",
              includeMode: "new-file",
              hash: "new-file",
              language: "TypeScript",
              sizeBytes: 0,
              tokenEstimate: 0,
              summaryAvailable: false,
              snippetIncluded: false
            }
          ],
          artifactProvenance: [
            {
              label: "task graph",
              path: `.visp/features/${FEATURE_DIR}/task-graph.json`,
              hash: sha256(graphText),
              hashAlgorithm: "sha256"
            }
          ]
        })
      ),
      "utf8"
    );
    await writeTaskPrompts(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        verify: { stdout: evidenceSummaryFixture() },
        review: { stdout: evidenceSummaryFixture() },
        reconcile: { stdout: reconcileSummaryFixture() },
        next: { stdout: workflowActionFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    ) as { selectedFiles: Array<Record<string, unknown>> };
    expect.soft(manifest.selectedFiles).toEqual([
      {
        path: "generated/new-feature.ts",
        reason: "planned task output",
        hasContent: true
      }
    ]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    expect.soft(logs.join("\n")).toContain("reason_code: kit_post_checkpoint_transition_unavailable");
    const commands = (await readArgvLog(shim.argvLogPath)).map((args) => args[0]);
    expect.soft(commands.slice(-6)).toEqual([
      "status",
      "integration",
      "verify",
      "review",
      "reconcile",
      "next"
    ]);
  });

  it.each([
    { label: "one-task completion", singleTask: true },
    { label: "two-task advancement", singleTask: false }
  ])("FAIL_CLOSED: successful summaries do not authorize $label without post-checkpoint state", async ({ singleTask }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath, { singleTask });

    const checkpointShim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() },
        next: { stdout: workflowActionFixture() }
      })
    );
    prependToPath(dirname(checkpointShim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toMatch(/status: (?:BLOCKED|INCONCLUSIVE)/u);
    expect.soft(output).toContain("reason_code: kit_post_checkpoint_transition_unavailable");
    expect.soft(output).not.toContain("status: PASSED");
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect.soft(output).not.toContain("next_task:");
    expect.soft(output).not.toContain("pipeline_complete: true");
    expect.soft(output).toContain("BEGIN_VISP_WORKFLOW_ACTION_V2");

    const argv = await readArgvLog(checkpointShim.argvLogPath);
    expect.soft(argv.map((args) => args[0])).toEqual([
      "status",
      "integration",
      "verify",
      "review",
      "reconcile",
      "next"
    ]);

    const pipeline = activePipeline(await readState(projectPath));
    expect.soft(pipeline.currentTaskId).toBe("T001");
    expect.soft(pipeline.completed).not.toContain("T001");
    expect.soft(pipeline.injectedTasks ?? []).toEqual([]);
  });

  it("FAIL_CLOSED: repeated failed Kit checkpoints never inject Hyper remediation or strict assurance", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);

    const failShim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: { success: false, errors: ["verification failed"] } },
        review: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(failShim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect.soft(output).not.toContain("next_task:");
    expect.soft(output).not.toContain("pipeline_complete: true");

    const pipeline = activePipeline(await readState(projectPath));
    expect.soft(pipeline.currentTaskId).toBe("T001");
    expect.soft(pipeline.completed).not.toContain("T001");
    expect.soft(pipeline.injectedTasks ?? []).toEqual([]);
    expect.soft(pipeline.decisionLog ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "inject-remediation" })])
    );
  });

  it("FAIL_CLOSED: incoherent successful Kit evidence cannot trigger reconcile", async () => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        verify: {
          stdout: { success: true, errors: ["verification process was interrupted"] }
        },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: kit_verify_incoherent");
    expect.soft(output).toContain("verify error: verification process was interrupted");
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("next_task:");
    expect.soft(output).not.toContain("pipeline_complete: true");

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "reconcile")).toBe(false);
  });

  it.each(["verify", "review", "reconcile"] as const)(
    "FAIL_CLOSED: a structured error finding from %s stops all later checkpoint stages",
    async (stage) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const errorFindings = [{ severity: " error ", message: `${stage} found an unsafe change` }];
    const errorSummary = evidenceSummaryFixture({
      findings: errorFindings
    });
    const shim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: stage === "verify" ? errorSummary : evidenceSummaryFixture() },
        review: { stdout: stage === "review" ? errorSummary : evidenceSummaryFixture() },
        reconcile: {
          stdout:
            stage === "reconcile"
              ? reconcileSummaryFixture({ findings: errorFindings })
              : reconcileSummaryFixture()
        }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toContain(`${stage} found an unsafe change`);
    const argv = await readArgvLog(shim.argvLogPath);
    const expectedStages =
      stage === "verify"
        ? ["status", "integration", "verify"]
        : stage === "review"
          ? ["status", "integration", "verify", "review"]
          : ["status", "integration", "verify", "review", "reconcile"];
    expect.soft(argv.map((args) => args[0])).toEqual(expectedStages);
    }
  );

  it.each(["verify", "review", "reconcile"] as const)(
    "FAIL_CLOSED: %s evidence for another task cannot authorize a later checkpoint stage",
    async (stage) => {
      const projectPath = await createProject();
      await createStrictSession(projectPath);
      const wrongTaskSummary = evidenceSummaryFixture({ taskId: "T999" });
      const shim = await createVispShim(
        kitStatusSpec({
          verify: { stdout: stage === "verify" ? wrongTaskSummary : evidenceSummaryFixture() },
          review: { stdout: stage === "review" ? wrongTaskSummary : evidenceSummaryFixture() },
          reconcile: {
            stdout:
              stage === "reconcile"
                ? reconcileSummaryFixture({ taskId: "T999" })
                : reconcileSummaryFixture()
          },
          next: { stdout: workflowActionFixture() }
        })
      );
      prependToPath(dirname(shim.binary));

      logs = [];
      await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

      const output = logs.join("\n");
      expect.soft(output).toContain("status: FAILED");
      expect.soft(output).toContain(`${stage} evidence identifies task T999; expected T001`);
      const argv = await readArgvLog(shim.argvLogPath);
      const expectedStages =
        stage === "verify"
          ? ["status", "integration", "verify"]
          : stage === "review"
            ? ["status", "integration", "verify", "review"]
            : ["status", "integration", "verify", "review", "reconcile"];
      expect.soft(argv.map((args) => args[0])).toEqual(expectedStages);
    }
  );

  it.each([
    {
      label: "not requested",
      traceabilityUpdate: { requested: false, performed: false, updatedFiles: [] },
      finding: "does not confirm that a traceability update was requested"
    },
    {
      label: "not performed",
      traceabilityUpdate: { requested: true, performed: false, updatedFiles: [] },
      finding: "does not confirm that traceability was updated"
    },
    {
      label: "reported without an updated artifact",
      traceabilityUpdate: { requested: true, performed: true, updatedFiles: [] },
      finding: `does not identify the updated traceability artifact .visp/features/${FEATURE_DIR}/traceability.json`
    },
    {
      label: "reported for an unrelated artifact",
      traceabilityUpdate: {
        requested: true,
        performed: true,
        updatedFiles: [`.visp/features/${FEATURE_DIR}/unrelated.json`]
      },
      finding: `does not identify the updated traceability artifact .visp/features/${FEATURE_DIR}/traceability.json`
    }
  ])("FAIL_CLOSED: reconcile traceability $label stops before next", async ({ traceabilityUpdate, finding }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const shim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: evidenceSummaryFixture() },
        review: { stdout: evidenceSummaryFixture() },
        reconcile: { stdout: reconcileSummaryFixture({ traceabilityUpdate }) },
        next: { stdout: workflowActionFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toContain(finding);
    expect.soft((await readArgvLog(shim.argvLogPath)).map((args) => args[0])).toEqual([
      "status",
      "integration",
      "verify",
      "review",
      "reconcile"
    ]);
  });

  it.each([
    { label: "missing", content: null },
    { label: "blank", content: "\n" },
    {
      label: "wrong-task",
      content: [
        "# Visp Task Implementation Prompt",
        "",
        "- Selected task ID: T999",
        "",
        "Feature-specific prompt:",
        `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`,
        ""
      ].join("\n")
    }
  ])("FAIL_CLOSED: $label read-latest prompt stops checkpoint before verify", async ({ content }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);
    const pipelineBefore = activePipeline(await readState(projectPath));
    const promptPath = join(projectPath, ".visp", "prompts", "current-task.prompt.md");
    if (content === null) {
      await rm(promptPath);
    } else {
      await writeFile(promptPath, content, "utf8");
    }
    const shim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: reconcileSummaryFixture() }
      })
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output).toMatch(/current task prompt/i);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.map((args) => args[0])).toEqual(["status", "integration"]);
    const pipelineAfter = activePipeline(await readState(projectPath));
    expect.soft(pipelineAfter.currentTaskId).toBe(pipelineBefore.currentTaskId);
    expect.soft(pipelineAfter.completed).toEqual(pipelineBefore.completed);
  });

  it.each([
    {
      stage: "verify",
      checkpoint: {
        verify: { stdout: { success: false, errors: ["verification failed"] } },
        review: { stdout: { success: true } }
      }
    },
    {
      stage: "review",
      checkpoint: {
        verify: { stdout: { success: true } },
        review: { stdout: { success: false, errors: ["review failed"] } }
      }
    },
    {
      stage: "reconcile",
      checkpoint: {
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: {
          stdout: reconcileSummaryFixture({ success: false, errors: ["provenance drift"] })
        }
      }
    }
  ])("FAIL_CLOSED: failed $stage evidence never grants strict assurance or Hyper remediation", async ({ stage, checkpoint }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);

    const shim = await createVispShim(kitStatusSpec(checkpoint as ShimSpec));
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect.soft(output).toContain("status: FAILED");
    expect.soft(output.toLowerCase()).toContain(stage);
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect.soft(output).not.toContain("next_task:");
    expect.soft(output).not.toContain("pipeline_complete: true");

    const pipeline = activePipeline(await readState(projectPath));
    expect.soft(pipeline.currentTaskId).toBe("T001");
    expect.soft(pipeline.completed).not.toContain("T001");
    expect.soft(pipeline.injectedTasks ?? []).toEqual([]);

    const argv = await readArgvLog(shim.argvLogPath);
    const evidenceCommands = argv
      .map((args) => args[0])
      .filter((command) => ["verify", "review", "reconcile", "next"].includes(command));
    expect.soft(evidenceCommands).toEqual(
      stage === "verify"
        ? ["verify"]
        : stage === "review"
          ? ["verify", "review"]
          : ["verify", "review", "reconcile"]
    );
  });

  it.each([
    {
      stage: "verify",
      checkpoint: {
        verify: { stdout: "malformed verify result" },
        review: { stdout: { success: true } }
      }
    },
    {
      stage: "review",
      checkpoint: {
        verify: { stdout: { success: true } },
        review: { stdout: "malformed review result" }
      }
    },
    {
      stage: "reconcile",
      checkpoint: {
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: "malformed reconcile result" }
      }
    }
  ])("FAIL_CLOSED: inconclusive $stage evidence never grants strict assurance or advancement", async ({ stage, checkpoint }) => {
    const projectPath = await createProject();
    await createStrictSession(projectPath);

    const shim = await createVispShim(kitStatusSpec(checkpoint as ShimSpec));
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output.toLowerCase()).toContain(stage);
    expect.soft(output).not.toContain("assurance_level: kit_strict");
    expect.soft(output).not.toContain("instruction:");
    expect.soft(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect.soft(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect.soft(output).not.toContain("next_task:");
    expect.soft(output).not.toContain("pipeline_complete: true");

    const pipeline = activePipeline(await readState(projectPath));
    expect.soft(pipeline.currentTaskId).toBe("T001");
    expect.soft(pipeline.completed).not.toContain("T001");
    expect.soft(pipeline.injectedTasks ?? []).toEqual([]);

    const argv = await readArgvLog(shim.argvLogPath);
    const evidenceCommands = argv
      .map((args) => args[0])
      .filter((command) => ["verify", "review", "reconcile", "next"].includes(command));
    expect.soft(evidenceCommands).toEqual(
      stage === "verify"
        ? ["verify"]
        : stage === "review"
          ? ["verify", "review"]
          : ["verify", "review", "reconcile"]
    );
  });
});

async function listFeatureFiles(projectPath: string): Promise<string[]> {
  const featureRoot = join(projectPath, ".visp", "features");
  const result: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
      } else {
        result.push(rel);
      }
    }
  }
  await walk(featureRoot, "");
  return result.sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
