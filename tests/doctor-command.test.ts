import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createWorkflowActionV3Id } from "../src/kit/workflow-action-adapter.js";
import { TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES } from "../src/kit/workflow-action-protocol.js";
import {
  createVispShim,
  gateResultFixture,
  policyValidateFixture
} from "./helpers/visp-shim.js";

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-doctor-"));
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "hyper", "config.json"), "{}\n", "utf8");
  await writeFile(join(projectPath, ".visp", "hyper", "state.json"), "{}\n", "utf8");
  return projectPath;
}

async function writeKitArtifacts(projectPath: string): Promise<void> {
  const contextDir = join(projectPath, ".visp", "features", "001-demo", "context");
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  await writeFile(
    join(contextDir, "T001.context.json"),
    JSON.stringify({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "task target", content: "export {};\n" }],
      validationCommands: ["pnpm test"]
    }),
    "utf8"
  );
}

async function writeHyperGitHook(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".git", "hooks"), { recursive: true });
  await writeFile(join(projectPath, ".git", "hooks", "pre-commit"), "# visp-hyper-guard hook\n", "utf8");
}

function kitReadContractArtifacts(): Array<Record<string, unknown>> {
  return [
    {
      id: "context-pack",
      path: ".visp/features/001-demo/context/T001.context.json",
      role: "context-pack",
      mimeType: "application/json",
      requiredFor: ["handoff", "implementation", "checkpoint"],
      freshness: "hash-pinned"
    },
    {
      id: "implementation-checklist",
      path: ".visp/features/001-demo/context/T001.implementation-checklist.json",
      role: "checklist",
      mimeType: "application/json",
      requiredFor: ["implementation", "pr"],
      freshness: "gate-validated"
    }
  ];
}

function kit20IntegrationContract(
  projectPath: string,
  requiredArtifacts: Array<Record<string, unknown>> = kitReadContractArtifacts()
): Record<string, unknown> {
  return {
    success: true,
    contractVersion: "2.0",
    protocols: {
      workflowAction: {
        supported: ["2.0", "3.0"],
        default: "2.0",
        schemaHashes: {
          "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"],
          "3.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.0"]
        }
      }
    },
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.2" },
    targetPath: projectPath,
    initialized: true,
    activeFeature: { id: "001", slug: "demo", key: "001-demo", path: ".visp/features/001-demo" },
    activeTask: { id: "T001", title: "Demo task", status: "ready" },
    commands: {},
    capabilities: {
      governance: { failClosedGates: true },
      contextGrounding: {
        taskScopedContextPacks: true,
        artifactProvenance: true,
        orchestratorReadContract: true
      },
      evidence: { verification: true, review: true, reconciliation: true },
      enforcementSurfaces: { gitPreCommitHook: true, ciPolicyGate: true }
    },
    workflow: {
      freshnessChecks: [
        ".visp/features/<feature>/context/<task-id>.context.json",
        "contextPack.artifactProvenance[]"
      ]
    },
    artifacts: {
      kitSignals: [".visp/policy.json", ".visp/project.json"],
      projectStatus: ".visp/status.json",
      projectProfile: ".visp/project.json",
      featureRoot: ".visp/features",
      featureDir: ".visp/features/001-demo",
      taskGraph: ".visp/features/001-demo/task-graph.json",
      contextPack: ".visp/features/001-demo/context/T001.context.json",
      contextPrompt: ".visp/features/001-demo/context/T001.prompt.md"
    },
    orchestrator: {
      readContractVersion: "0.1",
      requiredArtifacts,
      freshnessPolicy: {
        contextPackHashPinned: true,
        provenanceArtifactsHashPinned: true,
        staleContextBlocks: ["implementation", "checkpoint", "pr"]
      }
    },
    warnings: []
  };
}

function doctorWorkflowActionV3(overrides: Record<string, unknown> = {}) {
  const unavailable = { state: "unavailable", reasonCode: "not_in_source_artifact" } as const;
  const action = {
    protocolVersion: "3.0",
    canonicalVersion: "1.0",
    actionId: `sha256:${"0".repeat(64)}`,
    phase: "implement",
    feature: { id: "001", slug: "demo" },
    task: {
      id: "T001",
      title: "Demo task",
      status: "ready",
      dependsOn: [],
      parallelizable: false
    },
    taskClass: unavailable,
    risk: { level: { state: "available", value: "medium" }, factors: unavailable },
    assurance: {
      level: "kit_strict",
      profile: unavailable,
      workflowStrictness: { state: "available", value: "strict" }
    },
    goal: "Implement the current task.",
    baseCommit: { state: "unavailable", reasonCode: "not_captured" },
    requiredReads: [],
    scope: {
      writablePaths: ["src/feature.ts"],
      expectedPaths: unavailable,
      forbiddenPaths: ["package.json"],
      operationLimits: unavailable
    },
    claims: unavailable,
    validationOracles: [],
    validationCommands: ["pnpm test"],
    requiredEvidence: unavailable,
    policy: {
      status: { state: "available", value: "valid" },
      appliedOverrides: { state: "available", value: [] }
    },
    findings: [],
    verdict: "ready",
    nextCommand: "visp implement",
    ...overrides
  };
  action.actionId = createWorkflowActionV3Id(action);
  return action;
}

async function writeActiveKitReadContract(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".visp", "hyper", "current"), { recursive: true });
  await writeFile(
    join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
    JSON.stringify({
      version: "0.1",
      sessionId: "vh_test",
      kitReadContract: {
        contractVersion: "2.0",
        readContractVersion: "0.1",
        requiredArtifacts: kitReadContractArtifacts(),
        freshnessPolicy: {
          contextPackHashPinned: true,
          provenanceArtifactsHashPinned: true,
          staleContextBlocks: ["implementation", "checkpoint", "pr"]
        }
      }
    }),
    "utf8"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

describe("doctor command", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("checks the healthy Visp Kit bridge path", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    await writeActiveKitReadContract(projectPath);
    await writeHyperGitHook(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" }
        }
      },
      integration: {
        stdout: kit20IntegrationContract(projectPath)
      },
      next: { stdout: doctorWorkflowActionV3() },
      policy: { stdout: policyValidateFixture({ targetPath: projectPath }) },
      gate: {
        stdout: gateResultFixture({
          targetPath: projectPath,
          stage: "next",
          feature: { id: "001", slug: "demo" }
        })
      }
    });
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(summary.success).toBe(true);
    expect(summary.checks.find((check) => check.id === "hyper-version")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "mcp")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "mcp")?.detail).toContain("surface hash");
    expect(summary.checks.find((check) => check.id === "mcp")?.detail).toContain("input/output schemas");
    expect(summary.checks.find((check) => check.id === "kit-binary")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.detail).toContain("fail-closed gates");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.detail).toContain("artifact provenance");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.detail).toContain("orchestrator read contract");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.detail).toContain("provenance freshness");
    expect(summary.checks.find((check) => check.id === "kit-contract")?.detail).toContain("git+CI enforcement");
    const actionProtocol = summary.checks.find((check) => check.id === "kit-workflow-action");
    expect(actionProtocol?.status).toBe("pass");
    expect(actionProtocol?.detail).toContain("visp-kit 0.1.2");
    expect(actionProtocol?.detail).toContain("integration contract 2.0");
    expect(actionProtocol?.detail).toContain("protocol 3.0");
    expect(actionProtocol?.detail).toContain("advertised_verified");
    expect(actionProtocol?.detail).toContain(TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.0"]);
    expect(actionProtocol?.detail).toContain("verdict ready");
    expect(actionProtocol?.detail).toContain(
      "Configured strict surfaces consume this negotiated canonical action."
    );
    expect(actionProtocol?.detail).not.toContain(
      "remain on WorkflowAction 2.0 until P1-07"
    );
    expect(summary.checks.find((check) => check.id === "kit-read-contract")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-read-contract")?.detail).toContain("2 required artifacts");
    expect(summary.checks.find((check) => check.id === "kit-policy")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-context-pack")?.detail).toContain("T001");
    expect(summary.checks.find((check) => check.id === "git-hook")?.status).toBe("pass");

    const argvLog = await readFile(shim.argvLogPath, "utf8");
    expect(argvLog).toContain('["policy","validate","--json"]');
    expect(argvLog).toContain('["gate","next","--json"]');
    expect(argvLog).toContain('["next","--format","json","--protocol","3.0","--json"]');
  });

  it("warns when the active handoff lacks the Kit read contract", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    await writeHyperGitHook(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" }
        }
      },
      integration: {
        stdout: kit20IntegrationContract(projectPath, kitReadContractArtifacts().slice(0, 1))
      },
      next: { stdout: doctorWorkflowActionV3() },
      policy: { stdout: policyValidateFixture({ targetPath: projectPath }) },
      gate: {
        stdout: gateResultFixture({
          targetPath: projectPath,
          stage: "next",
          feature: { id: "001", slug: "demo" }
        })
      }
    });
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
      nextCommand: string;
    };
    const readContract = summary.checks.find((check) => check.id === "kit-read-contract");
    expect(summary.success).toBe(true);
    expect(readContract?.status).toBe("warn");
    expect(readContract?.detail).toContain("no context manifest");
    expect(summary.nextCommand).toContain("visp-hyper run");
  });

  it("warns when the Kit contract lacks provenance freshness support", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" }
        }
      },
      integration: {
        stdout: {
          success: true,
          contractVersion: "2.0",
          kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "001", slug: "demo", key: "001-demo", path: ".visp/features/001-demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" },
          commands: {},
          workflow: {
            freshnessChecks: [".visp/features/<feature>/context/<task-id>.context.json"]
          },
          artifacts: {
            kitSignals: [".visp/policy.json", ".visp/project.json"],
            projectStatus: ".visp/status.json",
            projectProfile: ".visp/project.json",
            featureRoot: ".visp/features",
            featureDir: ".visp/features/001-demo",
            taskGraph: ".visp/features/001-demo/task-graph.json",
            contextPack: ".visp/features/001-demo/context/T001.context.json",
            contextPrompt: ".visp/features/001-demo/context/T001.prompt.md"
          },
          warnings: []
        }
      },
      next: {
        stdout: {
          protocolVersion: "2.0",
          phase: "implement",
          taskId: "T001",
          goal: "Implement the current task.",
          requiredReads: [],
          writablePaths: ["src/feature.ts"],
          forbiddenPaths: [],
          acceptanceOracles: [],
          validationCommands: ["pnpm test"],
          assuranceLevel: "kit_strict",
          verdict: "ready",
          findings: [],
          nextCommand: "visp implement"
        }
      },
      policy: { stdout: policyValidateFixture({ targetPath: projectPath }) },
      gate: {
        stdout: gateResultFixture({
          targetPath: projectPath,
          stage: "next",
          feature: { id: "001", slug: "demo" }
        })
      }
    });
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
      nextCommand: string;
    };
    const contract = summary.checks.find((check) => check.id === "kit-contract");
    const actionProtocol = summary.checks.find((check) => check.id === "kit-workflow-action");
    expect(summary.success).toBe(true);
    expect(contract?.status).toBe("warn");
    expect(contract?.detail).toContain("does not advertise provenance freshness");
    expect(actionProtocol?.status).toBe("pass");
    expect(actionProtocol?.detail).toContain("protocol 2.0");
    expect(actionProtocol?.detail).toContain("legacy_unadvertised");
    expect(summary.nextCommand).toContain("provenance freshness");
  });

  it("warns, but does not fail, when the strict Kit backend is absent", async () => {
    const projectPath = await createProject();

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string }>;
      nextCommand: string;
    };
    expect(summary.success).toBe(true);
    expect(summary.checks.find((check) => check.id === "kit-artifacts")?.status).toBe("warn");
    expect(summary.nextCommand).toContain("visp init");
  });

  it("fails closed when the selected advertised WorkflowAction hash is untrusted", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    const contract = kit20IntegrationContract(projectPath);
    const protocols = contract.protocols as {
      workflowAction: { schemaHashes: Record<string, string> };
    };
    protocols.workflowAction.schemaHashes = {
      ...protocols.workflowAction.schemaHashes,
      "3.0": `sha256:${"0".repeat(64)}`
    };
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" }
        }
      },
      integration: { stdout: contract },
      policy: { stdout: policyValidateFixture({ targetPath: projectPath }) },
      gate: {
        stdout: gateResultFixture({
          targetPath: projectPath,
          stage: "next",
          feature: { id: "001", slug: "demo" }
        })
      }
    });
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    const protocol = summary.checks.find((check) => check.id === "kit-workflow-action");
    expect(summary.success).toBe(false);
    expect(protocol?.status).toBe("fail");
    expect(protocol?.detail).toContain("workflow_action_schema_hash_mismatch");
    expect((await readFile(shim.argvLogPath, "utf8"))).not.toContain('["next"');
  });

  it("fails when the active context artifact is stale", async () => {
    const projectPath = await createProject();
    const contextDir = join(projectPath, ".visp", "features", "001-demo", "context");
    const contextPath = join(contextDir, "T001.context.json");
    const originalContext = JSON.stringify({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "task target" }]
    });
    await mkdir(contextDir, { recursive: true });
    await mkdir(join(projectPath, ".visp", "hyper", "current"), { recursive: true });
    await writeFile(contextPath, originalContext, "utf8");
    await mkdir(join(projectPath, ".visp", "hyper", "current"), { recursive: true });
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
      JSON.stringify({
        version: "0.1",
        sessionId: "vh_test",
        contextArtifact: {
          path: ".visp/features/001-demo/context/T001.context.json",
          hash: sha256(originalContext),
          hashAlgorithm: "sha256"
        }
      }),
      "utf8"
    );
    await writeFile(
      contextPath,
      JSON.stringify({
        taskId: "T001",
        includedFiles: [{ path: "src/feature.ts", reason: "changed after handoff" }]
      }),
      "utf8"
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
      nextCommand: string;
    };
    const context = summary.checks.find((check) => check.id === "context-freshness");
    expect(summary.success).toBe(false);
    expect(context?.status).toBe("fail");
    expect(context?.detail).toContain("context artifact changed since handoff");
    expect(summary.nextCommand).toContain("visp-hyper run");
    expect(process.exitCode).toBe(1);
  });

  it("fails when Kit artifacts exist but the visp binary cannot be executed", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-path-"));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(summary.success).toBe(false);
    expect(summary.checks.find((check) => check.id === "kit-binary")?.status).toBe("fail");
    expect(process.exitCode).toBe(1);
  });
});
