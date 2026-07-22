import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createWorkflowActionV3Id } from "../src/kit/workflow-action-adapter.js";
import type { WorkflowActionV3Wire } from "../src/kit/workflow-action-protocol.js";
import {
  authoritativeContextPackFixture,
  authoritativeTaskFixture,
  authoritativeTaskGraphFixture,
  createVispShim,
  gateResultFixture,
  policyValidateFixture,
  type ShimSpec
} from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;
const V2_HASH =
  "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6";
const V3_HASH =
  "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7";

const FEATURE_DIR = "001-pipeline";
const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });

async function createProject(options: { withSpaces?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "visp-run-"));
  const projectPath = options.withSpaces ? join(root, "project with spaces") : root;
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
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
}

async function mutateContextPack(
  projectPath: string,
  mutate: (context: any) => void
): Promise<void> {
  const contextPath = join(
    projectPath,
    ".visp",
    "features",
    FEATURE_DIR,
    "context",
    "T001.context.json"
  );
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  mutate(context);
  await writeFile(contextPath, JSON.stringify(context), "utf8");
}

function integrationContractFixture(contractVersion = "2.0", protocols?: unknown) {
  return {
    success: true,
    contractVersion,
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo",
    initialized: true,
    activeFeature: { id: "001", slug: "pipeline", key: FEATURE_DIR, path: `.visp/features/${FEATURE_DIR}` },
    activeTask: { id: "T001", title: "First task", status: "ready" },
    commands: {},
    capabilities: {
      governance: { failClosedGates: true, sourceEditsRequireImplementGate: true },
      contextGrounding: {
        taskScopedContextPacks: true,
        artifactProvenance: true,
        orchestratorReadContract: true
      },
      evidence: { verification: true, review: true, reconciliation: true }
    },
    workflow: {
      failClosedOn: ["policyValidate", "gateNext", "gateImplement"],
      freshnessChecks: ["contextPack.artifactProvenance[]"]
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
      freshnessPolicy: {
        contextPackHashPinned: true,
        provenanceArtifactsHashPinned: true,
        staleContextBlocks: ["implementation", "checkpoint", "pr"]
      }
    },
    warnings: [],
    ...(protocols === undefined ? {} : { protocols })
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

function workflowActionV3Fixture(
  overrides: Record<string, unknown> = {}
): WorkflowActionV3Wire {
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
    risk: { level: available("high" as const), factors: unavailable() },
    assurance: {
      level: "kit_strict" as const,
      profile: unavailable(),
      workflowStrictness: available("strict" as const)
    },
    goal: "Implement the first task",
    baseCommit: unavailable("not_captured"),
    requiredReads: [],
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
    nextCommand: 'visp implement --task "T001 exact"',
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  } as WorkflowActionV3Wire;
}

function advertisedIntegrationContractFixture() {
  return integrationContractFixture("2.0", {
    workflowAction: {
      supported: ["2.0", "3.0"],
      default: "2.0",
      schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH }
    }
  });
}

async function workflowActionV3ForProject(
  projectPath: string,
  overrides: Record<string, unknown> = {}
) {
  const path = `.visp/features/${FEATURE_DIR}/context/T001.context.json`;
  const taskGraphPath = `.visp/features/${FEATURE_DIR}/task-graph.json`;
  const [raw, taskGraphRaw] = await Promise.all([
    readFile(join(projectPath, path), "utf8"),
    readFile(join(projectPath, taskGraphPath), "utf8")
  ]);
  return workflowActionV3Fixture({
    requiredReads: [
      {
        id: "task-graph",
        role: "task_graph",
        path: taskGraphPath,
        contentHash: `sha256:${sha256(taskGraphRaw)}`,
        freshness: "content_hash"
      },
      {
        id: "task-context",
        role: "context_pack",
        path,
        contentHash: `sha256:${sha256(raw)}`,
        freshness: "content_hash"
      }
    ],
    ...overrides
  });
}

function preAdoptionStrictRunSpec(extra: ShimSpec = {}): ShimSpec {
  return kitStatusSpec({
    integration: { stdout: advertisedIntegrationContractFixture() },
    next: {
      stdout: workflowActionV3Fixture({
        requiredReads: [
          {
            id: "task-context",
            role: "context_pack",
            path: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
            contentHash: `sha256:${"0".repeat(64)}`,
            freshness: "content_hash"
          }
        ]
      })
    },
    policy: { stdout: policyValidateFixture() },
    ...allowedRunGateSpec(),
    ...extra
  });
}

async function eligibleStrictRunSpec(
  projectPath: string,
  extra: ShimSpec = {}
): Promise<ShimSpec> {
  return preAdoptionStrictRunSpec({
    next: { stdout: await workflowActionV3ForProject(projectPath) },
    ...extra
  });
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
    integration: { stdout: integrationContractFixture() },
    ...extra
  };
}

function allowedRunGateSpec(): ShimSpec {
  return {
    "gate next": { stdout: gateResultFixture({ stage: "next" }) },
    "gate implement": { stdout: gateResultFixture({ stage: "implement" }) }
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

async function expectHyperAbsent(projectPath: string): Promise<void> {
  await expect(stat(join(projectPath, ".visp", "hyper"))).rejects.toMatchObject({
    code: "ENOENT"
  });
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
  const shim = await createVispShim(await eligibleStrictRunSpec(projectPath));
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
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("AC006: kit-less run mirrors start (handoff printed, current files written)", async () => {
    const projectPath = await createProject();
    const emptyDir = await mkdtemp(join(tmpdir(), "visp-empty-"));
    process.env.PATH = emptyDir;

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement feature", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output.match(/BEGIN_VISP_AGENT_HANDOFF/gu)).toHaveLength(1);
    expect(output.match(/END_VISP_AGENT_HANDOFF/gu)).toHaveLength(1);
    expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).not.toContain("BEGIN_VISP_MODEL_ROUTING");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    expect(output).not.toContain("BEGIN_VISP_NEXT_ACTION");
    expect(process.exitCode).toBeFalsy();

    const session = await readFile(join(projectPath, ".visp", "hyper", "current", "session.md"), "utf8");
    expect(session).toContain("implement feature");
    const state = await readState(projectPath);
    expect(Object.keys(state.sessions)).toHaveLength(1);
    expect(state.sessions[state.activeSessionId!]).toMatchObject({
      goal: "implement feature",
      tool: "codex",
      phase: "implementation"
    });
    expect(state.sessions[state.activeSessionId!]?.pipeline).toBeUndefined();
    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      goal: "implement feature",
      contextSource: "visp-hyper relevance scanner",
      validationCommands: [],
      nextCommand: "visp-hyper next"
    });
    expect(manifest.taskId).toBeUndefined();
    expect(manifest.contextArtifact).toBeUndefined();
    expect(manifest.artifactProvenance).toBeUndefined();
    const handoff = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")
    );
    expect(handoff.session.goal).toBe("implement feature");
    expect((await readdir(join(projectPath, ".visp", "hyper", "current"))).sort()).toEqual([
      "agent-instructions.md",
      "context-manifest.json",
      "context-pack.md",
      "handoff.json",
      "memory-pack.md",
      "quality-gates.md",
      "session.md"
    ]);
  });

  it("FAIL_CLOSED: configured project with a missing Kit binary never enters local run", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: binary_not_found");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
  });

  it("FAIL_CLOSED: success false status never enters local or strict run", async () => {
    const projectPath = await createProject();
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
    await expectHyperAbsent(projectPath);
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
    expect.soft(process.exitCode).toBe(1);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).toBe(stateBefore);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")).toBe(handoffBefore);
  });

  it("FAIL_CLOSED: unsupported integration contract blocks run before policy, gates, or session", async () => {
    const projectPath = await createProject();
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
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.slice(0, 2)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"]
    ]);
    expect.soft(argv.some((args) => args[0] === "policy")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
  });

  it("FAIL_CLOSED: integration contract 2.0 with success false blocks before policy, gates, or session", async () => {
    const projectPath = await createProject();
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
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"]
    ]);
  });

  it.each([
    {
      failure: "selected schema hash mismatch",
      reasonCode: "workflow_action_schema_hash_mismatch",
      nextCalled: false
    },
    {
      failure: "missing action output",
      reasonCode: "workflow_action_schema_invalid",
      nextCalled: true
    },
    {
      failure: "malformed action output",
      reasonCode: "workflow_action_schema_invalid",
      nextCalled: true
    },
    {
      failure: "selected protocol mismatch",
      reasonCode: "workflow_action_protocol_mismatch",
      nextCalled: true
    },
    {
      failure: "ready action from a failed command",
      reasonCode: "workflow_action_contradiction",
      nextCalled: true
    },
    {
      failure: "ready verdict with a blocking finding",
      reasonCode: "workflow_action_contradiction",
      nextCalled: true
    },
    {
      failure: "contract/action task identity race",
      reasonCode: "workflow_action_contradiction",
      nextCalled: true
    }
  ])(
    "FAIL_CLOSED: run rejects $failure before policy, gates, or Hyper writes",
    async ({ failure, reasonCode, nextCalled }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      const spec = await eligibleStrictRunSpec(projectPath);

      if (failure === "selected schema hash mismatch") {
        const contract = advertisedIntegrationContractFixture() as any;
        contract.protocols.workflowAction.schemaHashes["3.0"] = `sha256:${"0".repeat(64)}`;
        spec.integration = { stdout: contract };
      } else if (failure === "missing action output") {
        delete spec.next;
      } else if (failure === "malformed action output") {
        spec.next = { stdout: "not workflow action json" };
      } else if (failure === "selected protocol mismatch") {
        spec.next = { stdout: workflowActionFixture() };
      } else if (failure === "ready action from a failed command") {
        spec.next = {
          stdout: await workflowActionV3ForProject(projectPath),
          exitCode: 1
        };
      } else if (failure === "ready verdict with a blocking finding") {
        spec.next = {
          stdout: await workflowActionV3ForProject(projectPath, {
            findings: [
              {
                code: "TEST_BLOCKING_FINDING",
                source: "workflow",
                severity: "error",
                effect: "blocks",
                message: "The action is blocked.",
                recommendation: "Resolve the blocking finding.",
                evidence: ["fixture"]
              }
            ]
          })
        };
      } else {
        spec.next = {
          stdout: await workflowActionV3ForProject(projectPath, {
            task: {
              id: "T999",
              title: "Different canonical task",
              status: "ready",
              dependsOn: [],
              parallelizable: false
            }
          })
        };
      }
      const shim = await createVispShim(spec);
      prependToPath(dirname(shim.binary));

      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

      const output = logs.join("\n");
      expect(output).toContain(`reason_code: ${reasonCode}`);
      expect(output.match(/BEGIN_VISP_KIT_AUTHORITY_RESULT/gu)).toHaveLength(1);
      expectNoLocalFallthrough(output);
      expectNoInventedRecovery(output);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      const argv = await readArgvLog(shim.argvLogPath);
      expect(argv.some((args) => args[0] === "next")).toBe(nextCalled);
      expect(argv.some((args) => args[0] === "policy")).toBe(false);
      expect(argv.some((args) => args[0] === "gate")).toBe(false);
    }
  );

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
    await writeTaskGraph(projectPath);
    const spec = preAdoptionStrictRunSpec();
    if (policy) {
      spec.policy = policy;
    } else {
      delete spec.policy;
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
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.slice(0, 4)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"],
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
      await writeTaskGraph(projectPath);
      const spec = preAdoptionStrictRunSpec();
      if (gate) {
        spec["gate next"] = gate;
      } else {
        delete spec["gate next"];
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
      await expectHyperAbsent(projectPath);
      const argv = await readArgvLog(shim.argvLogPath);
      expect.soft(argv.slice(0, 5)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        ["next", "--format", "json", "--protocol", "3.0", "--json"],
        ["policy", "validate", "--json"],
        ["gate", "next", "--json"]
      ]);
      expect.soft(
        argv.some((args) => args[0] === "gate" && args[1] === "implement")
      ).toBe(false);
    }
  );

  it("FAIL_CLOSED: gate-next must evaluate the canonical task identity", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const shim = await createVispShim(
      preAdoptionStrictRunSpec({
        "gate next": {
          stdout: gateResultFixture({ stage: "next", taskId: "T999" })
        }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    const output = logs.join("\n");
    expect(output).toContain("reason_code: gate_next_task_mismatch");
    expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    await expectHyperAbsent(projectPath);
  });

  it.each([
    { mismatch: "status task identity" },
    { mismatch: "status task status" },
    { mismatch: "contract task status" },
    { mismatch: "task-graph task status" }
  ])(
    "FAIL_CLOSED: canonical action and $mismatch disagreement writes no Hyper state",
    async ({ mismatch }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);

      if (mismatch === "task-graph task status") {
        const graphPath = join(
          projectPath,
          ".visp",
          "features",
          FEATURE_DIR,
          "task-graph.json"
        );
        const graph = JSON.parse(await readFile(graphPath, "utf8"));
        graph.tasks[0].status = "pending";
        await writeFile(graphPath, JSON.stringify(graph), "utf8");
      }

      const spec = await eligibleStrictRunSpec(projectPath);
      if (mismatch === "status task identity") {
        spec.status = {
          stdout: {
            success: true,
            initialized: true,
            activeFeature: { id: "001", slug: "pipeline" },
            activeTask: { id: "T999", title: "Different task", status: "ready" }
          }
        };
      } else if (mismatch === "status task status") {
        spec.status = {
          stdout: {
            success: true,
            initialized: true,
            activeFeature: { id: "001", slug: "pipeline" },
            activeTask: { id: "T001", title: "First task", status: "blocked" }
          }
        };
      } else if (mismatch === "contract task status") {
        const contract = advertisedIntegrationContractFixture() as any;
        contract.activeTask.status = "blocked";
        spec.integration = { stdout: contract };
      }
      const shim = await createVispShim(spec);
      prependToPath(dirname(shim.binary));

      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

      const output = logs.join("\n");
      expect(output).toContain("reason_code: task_unavailable");
      expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      expect(
        (await readArgvLog(shim.argvLogPath)).some(
          (args) => args[0] === "gate" && args[1] === "implement"
        )
      ).toBe(false);
    }
  );

  it("FAIL_CLOSED: missing configured task graph stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    const shim = await createVispShim(
      preAdoptionStrictRunSpec()
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_graph_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.map((args) => args.slice(0, 2))).toEqual([
      ["status", "--json"],
      ["integration", "contract"],
      ["next", "--format"],
      ["policy", "validate"],
      ["gate", "next"]
    ]);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: valid JSON with the wrong task-graph shape stops before context or implement gate", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "task-graph.json"),
      JSON.stringify({ featureId: "001", featureSlug: "pipeline", tasks: [] }),
      "utf8"
    );
    const shim = await createVispShim(
      preAdoptionStrictRunSpec()
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_graph_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: task graph without an executable task stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    await writeFile(
      join(projectPath, ".visp", "features", FEATURE_DIR, "task-graph.json"),
      JSON.stringify(authoritativeTaskGraphFixture({ tasks: [] })),
      "utf8"
    );
    const shim = await createVispShim(
      preAdoptionStrictRunSpec()
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: task_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it("FAIL_CLOSED: missing context pack stops before implement gate or session", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    await rm(join(projectPath, ".visp", "features", FEATURE_DIR, "context", "T001.context.json"));
    const shim = await createVispShim(
      preAdoptionStrictRunSpec()
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: context_pack_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);
  });

  it("FAIL_CLOSED: valid JSON with the wrong context-pack shape stops before implement gate", async () => {
    const projectPath = await createProject();
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
      preAdoptionStrictRunSpec()
    );
    prependToPath(dirname(shim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: context_pack_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(false);
  });

  it.each([
    { mismatch: "path", reasonCode: "context_pack_path_mismatch" },
    { mismatch: "hash", reasonCode: "context_pack_hash_mismatch" },
    { mismatch: "missing required read", reasonCode: "context_pack_required_read_missing" },
    { mismatch: "duplicate required read", reasonCode: "context_pack_required_read_missing" },
    {
      mismatch: "commands",
      reasonCode: "context_pack_validation_commands_mismatch"
    }
  ])(
    "FAIL_CLOSED: canonical context $mismatch mismatch writes no Hyper state",
    async ({ mismatch, reasonCode }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      const base = await workflowActionV3ForProject(projectPath);
      let requiredReads = base.requiredReads.map((read) =>
        read.role !== "context_pack"
          ? read
          : {
              ...read,
              ...(mismatch === "path"
                ? { path: `.visp/features/${FEATURE_DIR}/context/other.context.json` }
                : {}),
              ...(mismatch === "hash"
                ? { contentHash: `sha256:${"f".repeat(64)}` }
                : {})
            }
      );
      if (mismatch === "missing required read") {
        requiredReads = requiredReads.filter((read) => read.role !== "context_pack");
      } else if (mismatch === "duplicate required read") {
        const contextRead = requiredReads.find((read) => read.role === "context_pack")!;
        requiredReads = [...requiredReads, { ...contextRead, id: "task-context-copy" }];
      }
      const action = workflowActionV3Fixture({
        requiredReads,
        ...(mismatch === "commands"
          ? { validationCommands: ["pnpm test", "pnpm typecheck"] }
          : {})
      });
      const shim = await createVispShim(
        await eligibleStrictRunSpec(projectPath, { next: { stdout: action } })
      );
      prependToPath(dirname(shim.binary));

      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

      const output = logs.join("\n");
      expect(output).toContain(`reason_code: ${reasonCode}`);
      expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      expect(
        (await readArgvLog(shim.argvLogPath)).some(
          (args) => args[0] === "gate" && args[1] === "implement"
        )
      ).toBe(false);
    }
  );

  it.each([
    { mismatch: "selected task ID", reasonCode: "context_pack_task_mismatch" },
    { mismatch: "selected task status", reasonCode: "context_pack_task_mismatch" },
    { mismatch: "top-level task ID", reasonCode: "context_pack_unavailable" }
  ])(
    "FAIL_CLOSED: a context pack $mismatch mismatch writes no Hyper state",
    async ({ mismatch, reasonCode }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      await mutateContextPack(projectPath, (context) => {
        if (mismatch === "selected task ID") {
          context.selectedTask = authoritativeTaskFixture({
            id: "T002",
            title: "Different selected task"
          });
        } else if (mismatch === "selected task status") {
          context.selectedTask = authoritativeTaskFixture({ status: "blocked" });
        } else {
          context.taskId = "T002";
        }
      });
      const shim = await createVispShim(await eligibleStrictRunSpec(projectPath));
      prependToPath(dirname(shim.binary));

      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

      expect(logs.join("\n")).toContain(`reason_code: ${reasonCode}`);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
    }
  );

  it("FAIL_CLOSED: malformed existing Hyper config is read-only and blocks adoption", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const configPath = join(projectPath, ".visp", "hyper", "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ malformed", "utf8");
    const shim = await createVispShim(await eligibleStrictRunSpec(projectPath));
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    expect(logs.join("\n")).toContain("reason_code: hyper_config_unavailable");
    expect(await readFile(configPath, "utf8")).toBe("{ malformed");
    await expect(stat(join(projectPath, ".visp", "hyper", "state.json"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(stat(join(projectPath, ".visp", "hyper", "current"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(process.exitCode).toBe(1);
    expect(
      (await readArgvLog(shim.argvLogPath)).some(
        (args) => args[0] === "gate" && args[1] === "implement"
      )
    ).toBe(false);
  });

  it.each([
    { failure: "blocked file", reasonCode: "context_pack_selected_file_blocked" },
    { failure: "unsafe file path", reasonCode: "context_pack_selected_file_invalid" },
    { failure: "empty selected files", reasonCode: "context_pack_selected_file_unavailable" },
    { failure: "unreadable selected file", reasonCode: "context_pack_selected_file_unavailable" }
  ])(
    "FAIL_CLOSED: a context pack with $failure writes no Hyper state",
    async ({ failure, reasonCode }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      await mutateContextPack(projectPath, (context) => {
        if (failure === "blocked file") {
          context.includedFiles.push({
            ...context.includedFiles[0],
            path: ".env",
            reason: "Must be rejected by Hyper's configured blocked paths.",
            language: "dotenv"
          });
        } else if (failure === "unsafe file path") {
          context.includedFiles[0].path = "../outside.ts";
        } else if (failure === "empty selected files") {
          context.includedFiles = [];
        } else {
          context.includedFiles[0].path = "src/missing.ts";
        }
      });
      const shim = await createVispShim(await eligibleStrictRunSpec(projectPath));
      prependToPath(dirname(shim.binary));

      await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

      const output = logs.join("\n");
      expect(output).toContain(`reason_code: ${reasonCode}`);
      expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
      expectNoLocalFallthrough(output);
      expectNoInventedRecovery(output);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      const argv = await readArgvLog(shim.argvLogPath);
      expect(
        argv.some((args) => args[0] === "gate" && args[1] === "implement")
      ).toBe(false);
    }
  );

  it.each([
    { label: "missing", next: undefined, reasonCode: "workflow_action_schema_invalid" },
    { label: "malformed", next: { stdout: "not workflow action json" }, reasonCode: "workflow_action_schema_invalid" },
    {
      label: "unsupported",
      next: { stdout: workflowActionFixture("3.0") },
      reasonCode: "workflow_action_protocol_mismatch"
    },
    {
      label: "nonzero ready",
      next: { stdout: workflowActionFixture(), exitCode: 1 },
      reasonCode: "workflow_action_contradiction"
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
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
    expect.soft(argv.some((args) => args[0] === "gate")).toBe(false);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).toBe(stateBefore);
    expect.soft(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")).toBe(handoffBefore);
  });

  it("AC004: auto-v3 run writes a session bound to one canonical action", async () => {
    const projectPath = await createProject({ withSpaces: true });
    await writeTaskGraph(projectPath);
    const action = await workflowActionV3ForProject(projectPath, {
      goal: "Canonical implementation goal",
      nextCommand: 'visp gate implement --task "T001 exact"'
    });

    const shim = await createVispShim(
      kitStatusSpec({
        integration: { stdout: advertisedIntegrationContractFixture() },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: action }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw CLI goal", "--tool", "codex"]);
    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).toContain('"goal":"Canonical implementation goal"');
    expect(output).toContain('"nextCommand":"visp gate implement --task \\"T001 exact\\""');
    expect(output).not.toContain('"wire"');
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
    expect(output.indexOf("BEGIN_VISP_AGENT_HANDOFF")).toBeLessThan(
      output.indexOf("BEGIN_VISP_HYPER_ACTION_V1")
    );
    expect(output.indexOf("BEGIN_VISP_HYPER_ACTION_V1")).toBeLessThan(
      output.indexOf("BEGIN_VISP_MODEL_ROUTING")
    );
    expect(output).not.toContain("raw CLI goal");

    const state = await readState(projectPath);
    expect(Object.keys(state.sessions)).toHaveLength(1);
    const pipeline = activePipeline(state);
    expect(pipeline.currentTaskId).toBe("T001");
    expect(pipeline.taskIds).toEqual(["T001"]);

    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest.goal).toBe("Canonical implementation goal");
    expect(manifest.taskId).toBe("T001");
    expect(manifest.validationCommands).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(manifest.nextCommand).toBe('visp gate implement --task "T001 exact"');
    expect(manifest.artifactProvenance).toEqual(
      action.requiredReads.map((read) => ({
        label: read.id,
        path: read.path,
        hash: read.contentHash.slice("sha256:".length),
        hashAlgorithm: "sha256",
        source: "visp-kit"
      }))
    );
    expect(
      await readFile(join(projectPath, ".visp", "hyper", "current", "session.md"), "utf8")
    ).toContain("Canonical implementation goal");
    const contextPackRaw = await readFile(
      join(projectPath, ".visp", "hyper", "current", "context-pack.md"),
      "utf8"
    );
    expect(contextPackRaw).toContain("- Source: visp-kit context pack (T001)");
    expect(contextPackRaw.indexOf("- pnpm typecheck")).toBeLessThan(
      contextPackRaw.indexOf("- pnpm test")
    );
    const handoffRaw = await readFile(
      join(projectPath, ".visp", "hyper", "current", "handoff.json"),
      "utf8"
    );
    const handoff = JSON.parse(handoffRaw);
    expect(handoff.session).toMatchObject({
      goal: "Canonical implementation goal",
      pipeline: { taskIds: ["T001"], currentTaskId: "T001" }
    });
    const durableInstructions = (
      await Promise.all([
        readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"),
        readFile(join(projectPath, ".visp", "hyper", "current", "session.md"), "utf8"),
        Promise.resolve(contextPackRaw),
        readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8"),
        readFile(join(projectPath, ".visp", "hyper", "current", "memory-pack.md"), "utf8"),
        readFile(join(projectPath, ".visp", "hyper", "current", "quality-gates.md"), "utf8"),
        readFile(join(projectPath, ".visp", "hyper", "current", "agent-instructions.md"), "utf8"),
        readFile(join(projectPath, ".visp", "prompts", "visp-hyper-handoff.prompt.md"), "utf8"),
        Promise.resolve(handoffRaw)
      ])
    ).join("\n");
    expect(durableInstructions).not.toContain("raw CLI goal");
    expect(durableInstructions).not.toContain('"wire"');
    expect(
      (await readdir(join(projectPath, ".visp", "hyper", "current"))).sort()
    ).toEqual([
      "agent-instructions.md",
      "context-manifest.json",
      "context-pack.md",
      "handoff.json",
      "memory-pack.md",
      "quality-gates.md",
      "session.md"
    ]);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"],
      ["policy", "validate", "--json"],
      ["gate", "next", "--json"],
      ["gate", "implement", "--task", "T001", "--json"]
    ]);
    expect.soft(argv.filter((args) => args[0] === "status")).toHaveLength(1);
    expect.soft(argv.filter((args) => args[0] === "integration")).toHaveLength(1);
  });

  it.each([
    {
      mode: "legacy selector-less",
      contract: integrationContractFixture(),
      nextArgv: ["next", "--format", "json", "--json"]
    },
    {
      mode: "advertised v2-only",
      contract: integrationContractFixture("2.0", {
        workflowAction: {
          supported: ["2.0"],
          default: "2.0",
          schemaHashes: { "2.0": V2_HASH }
        }
      }),
      nextArgv: ["next", "--format", "json", "--protocol", "2.0", "--json"]
    }
  ])(
    "FAIL_CLOSED: a ready $mode action cannot authorize strict session state",
    async ({ contract, nextArgv }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      const shim = await createVispShim(
        kitStatusSpec({
          integration: { stdout: contract },
          next: { stdout: workflowActionFixture() }
        })
      );
      prependToPath(dirname(shim.binary));

      await runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "run",
        "raw CLI goal",
        "--tool",
        "codex"
      ]);

      const output = logs.join("\n");
      expect(output).toContain("reason_code: strict_session_adoption_unavailable");
      expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
      expect(output).toContain('"protocolVersion":"2.0"');
      expect(output).toContain('"verdict":"ready"');
      expectNoLocalFallthrough(output);
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      expect(await readArgvLog(shim.argvLogPath)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        nextArgv
      ]);
    }
  );

  it.each([
    { verdict: "blocked" as const, effect: "blocks" as const },
    { verdict: "inconclusive" as const, effect: "uncertain" as const }
  ])(
    "FAIL_CLOSED: a coherent v3 $verdict action renders once and writes no Hyper state",
    async ({ verdict, effect }) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      const action = await workflowActionV3ForProject(projectPath, {
        verdict,
        findings: [
          {
            code: `TEST_${verdict.toUpperCase()}`,
            source: "workflow",
            severity: "error",
            effect,
            message: `Canonical action is ${verdict}.`,
            recommendation: "Follow the canonical next command.",
            evidence: ["fixture"]
          }
        ]
      });
      const shim = await createVispShim(
        await eligibleStrictRunSpec(projectPath, {
          next: { stdout: action, exitCode: 1 }
        })
      );
      prependToPath(dirname(shim.binary));

      await runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "run",
        "raw CLI goal"
      ]);

      const output = logs.join("\n");
      expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
      expect(output).toContain(`"verdict":"${verdict}"`);
      expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
      expect(process.exitCode).toBe(1);
      await expectHyperAbsent(projectPath);
      expect(await readArgvLog(shim.argvLogPath)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        ["next", "--format", "json", "--protocol", "3.0", "--json"]
      ]);
    }
  );

  it("FAIL_CLOSED: a ready v3 non-implement phase cannot create strict session state", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const action = await workflowActionV3ForProject(projectPath, { phase: "verify" });
    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, { next: { stdout: action } })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    const output = logs.join("\n");
    expect(output).toContain("reason_code: strict_session_adoption_unavailable");
    expect(output).toContain('"value":"verify"');
    expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    await expectHyperAbsent(projectPath);
    expect((await readArgvLog(shim.argvLogPath)).some((args) => args[0] === "policy")).toBe(
      false
    );
  });

  it("FAIL_CLOSED: a coherent ready v3 action without a task cannot create strict session state", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const action = await workflowActionV3ForProject(projectPath, { task: null });
    const contract = advertisedIntegrationContractFixture() as any;
    contract.activeTask = null;
    const shim = await createVispShim(
      kitStatusSpec({
        status: {
          stdout: {
            success: true,
            initialized: true,
            activeFeature: { id: "001", slug: "pipeline" },
            activeTask: null
          }
        },
        integration: { stdout: contract },
        next: { stdout: action },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    const output = logs.join("\n");
    expect(output).toContain("reason_code: strict_session_adoption_unavailable");
    expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
    expect(output).toContain('"task":null');
    expect(process.exitCode).toBe(1);
    await expectHyperAbsent(projectPath);
    const argv = await readArgvLog(shim.argvLogPath);
    expect(argv.some((args) => args[0] === "policy")).toBe(false);
    expect(argv.some((args) => args[0] === "gate")).toBe(false);
  });

  it("FAIL_CLOSED: an invalid v3 action identity cannot initialize Hyper", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const action = {
      ...(await workflowActionV3ForProject(projectPath)),
      actionId: `sha256:${"f".repeat(64)}`
    };
    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, { next: { stdout: action } })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "raw goal"]);

    const output = logs.join("\n");
    expect(output).toContain("reason_code: workflow_action_identity_invalid");
    expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(process.exitCode).toBe(1);
    await expectHyperAbsent(projectPath);
  });

  it("ignores graph fan-out when one canonical action authorizes the strict session", async () => {
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
      JSON.stringify(authoritativeContextPackFixture({ selectedTask: firstTask })),
      "utf8"
    );

    const shim = await createVispShim(await eligibleStrictRunSpec(projectPath));
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement", "--tool", "claude-code"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_DIRECTIVE");
    expect(activePipeline(await readState(projectPath))).toMatchObject({
      taskIds: ["T001"],
      currentTaskId: "T001"
    });
  });

  it("warns when strict Kit mode uses a contract without provenance freshness", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        integration: {
          stdout: {
            success: true,
            contractVersion: "2.0",
            kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
            targetPath: projectPath,
            initialized: true,
            activeFeature: { id: "001", slug: "pipeline", key: FEATURE_DIR, path: `.visp/features/${FEATURE_DIR}` },
            activeTask: { id: "T001", title: "First task", status: "ready" },
            commands: {},
            capabilities: {
              governance: { failClosedGates: true },
              contextGrounding: { taskScopedContextPacks: true },
              evidence: { verification: true, review: true, reconciliation: true },
              enforcementSurfaces: { gitPreCommitHook: true, ciPolicyGate: true }
            },
            workflow: {
              freshnessChecks: [`.visp/features/<feature>/context/<task-id>.context.json`]
            },
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
              featureDir: `.visp/features/${FEATURE_DIR}`,
              taskGraph: `.visp/features/${FEATURE_DIR}/task-graph.json`,
              contextPack: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
              contextPrompt: `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`
            },
            warnings: []
          }
        },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: await workflowActionV3ForProject(projectPath) }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("warning: Kit integration contract 2.0 does not advertise provenance freshness");
    expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
  });

  it("FAIL_CLOSED: checkpoint fails when Kit provenance changes after handoff", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: { success: true } }
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
    expect(output).toContain("task-graph");

    const pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T001");
    const argv = await readArgvLog(shim.argvLogPath);
    expect(argv.some((args) => args[0] === "reconcile")).toBe(false);
  });

  it("checkpoint uses canonical required-read provenance when the context pack omits provenance", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath, { provenance: false });

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect(output).toContain("context_freshness: current");
    expect(output).not.toContain("has no artifactProvenance");
    expect(output).not.toContain("checkpoint can pin only the context-pack file");
  });

  it("AC005: blocked implement gate prints PIPELINE_BLOCKED without creating a session", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
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

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("R-IMPL-001");
    expect.soft(recoveryCommandLines(output)).toEqual(["next_allowed_command: visp specify"]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectHyperAbsent(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);

    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("blocked implement gate uses only the bare Kit nextCommand", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
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
    await expectHyperAbsent(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);
  });

  it("blocked implement gate does not substitute Kit nextAllowedCommand when nextCommand is absent", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        "gate implement": {
          stdout: gateResultFixture({
            stage: "implement",
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

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("R-IMPL-003");
    expect.soft(recoveryCommandLines(output)).toEqual([]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectHyperAbsent(projectPath);
  });

  it("AC002: strict next auto-selects v3 while genuine no-Kit next stays local", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        integration: {
          stdout: integrationContractFixture("2.0", {
            workflowAction: {
              supported: ["2.0", "3.0"],
              default: "2.0",
              schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH }
            }
          })
        },
        policy: { stdout: policyValidateFixture() },
        ...allowedRunGateSpec(),
        next: { stdout: await workflowActionV3ForProject(projectPath) }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const stateBeforeNext = await readFile(
      join(projectPath, ".visp", "hyper", "state.json"),
      "utf8"
    );
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    let output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).toContain('"frameVersion":"1.0"');
    expect(output).toContain('"protocolVersion":"3.0"');
    expect(output).toContain('"nextCommand":"visp implement --task \\"T001 exact\\""');
    expect(output).not.toContain('"wire"');
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    ).toBe(stateBeforeNext);
    expect(process.exitCode).toBeFalsy();
    expect(await readArgvLog(shim.argvLogPath)).toContainEqual([
      "next",
      "--format",
      "json",
      "--protocol",
      "3.0",
      "--json"
    ]);

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

  it.each(["blocked", "inconclusive"] as const)(
    "AC002: strict next renders a coherent %s action and exits nonzero",
    async (verdict) => {
      const projectPath = await createProject();
      await writeTaskGraph(projectPath);
      const shim = await createVispShim(
        kitStatusSpec({
          integration: {
            stdout: { ...integrationContractFixture(), activeTask: null }
          },
          next: {
            stdout: {
              ...workflowActionFixture(),
              taskId: null,
              writablePaths: [],
              verdict,
              findings: [`Kit action is ${verdict}`],
              nextCommand: "visp scan"
            },
            exitCode: 1
          }
        })
      );
      prependToPath(dirname(shim.binary));

      logs = [];
      await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

      const output = logs.join("\n");
      expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
      expect(output).toContain(`"verdict":"${verdict}"`);
      expect(output).toContain('"task":null');
      expect(output).toContain('"nextCommand":"visp scan"');
      expectNoLocalFallthrough(output);
      expect(process.exitCode).toBe(1);
    }
  );

  it("POLICY_BLOCKED: failing policy validate stops before any handoff or kit artifacts", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const nextCommand = "Fix .visp/policy.json and run `visp policy validate`.";

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      preAdoptionStrictRunSpec({
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
        ...allowedRunGateSpec()
      })
    );
    prependToPath(dirname(shim.binary));

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
    await expectHyperAbsent(projectPath);

    // No kit artifacts authored when policy is blocked.
    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("POLICY_BLOCKED: non-empty nested Kit errors block even when success and passed are true", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const nextCommand = "visp policy validate";
    const shim = await createVispShim(
      preAdoptionStrictRunSpec({
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

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_POLICY_BLOCKED");
    expect(output).toContain("Kit reported a policy error despite a successful validation flag.");
    expect.soft(recoveryCommandLines(output)).toEqual([`next_allowed_command: ${nextCommand}`]);
    expect(output).not.toContain("instruction:");
    expectNoLocalFallthrough(output);
    await expectHyperAbsent(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"],
      ["policy", "validate", "--json"]
    ]);
  });

  it.each([
    { label: "missing", implementGate: undefined },
    {
      label: "malformed",
      implementGate: { stdout: "not json at all — the gate crashed mid-output" }
    },
    {
      label: "wrong-task",
      implementGate: {
        stdout: gateResultFixture({ stage: "implement", taskId: "T999" })
      }
    }
  ])("FAIL_CLOSED: $label implement gate stops before session creation", async ({ implementGate }) => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);
    const spec = await eligibleStrictRunSpec(projectPath);
    if (implementGate) {
      spec["gate implement"] = implementGate;
    } else {
      delete spec["gate implement"];
    }
    const shim = await createVispShim(spec);
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect.soft(output).toContain("status: INCONCLUSIVE");
    expect.soft(output).toContain("reason_code: gate_implement_unavailable");
    expectNoLocalFallthrough(output);
    expectNoInventedRecovery(output);
    await expectHyperAbsent(projectPath);

    const argv = await readArgvLog(shim.argvLogPath);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "next")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "gate" && args[1] === "implement")).toBe(true);
    expect.soft(argv.some((args) => args[0] === "next")).toBe(true);
  });

  it("FAIL_CLOSED: checkpoint fails when the adopted Kit context artifact changed after handoff", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      await eligibleStrictRunSpec(projectPath, {
        verify: { stdout: { success: true } },
        review: { stdout: { success: true } },
        reconcile: { stdout: { success: true } }
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
        reconcile: { stdout: { success: true } },
        next: {
          stdout: {
            success: true,
            nextCommand: "visp pr",
            state: "ready",
            allowed: true
          }
        }
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
        reconcile: { stdout: { success: true } }
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
        reconcile: { stdout: { success: false, errors: ["provenance drift"] } }
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
    expect.soft(argv.some((args) => args[0] === "reconcile")).toBe(stage === "reconcile");
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
