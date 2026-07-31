import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectVisp,
  KitCommandBridge,
  KIT_DEFAULT_TIMEOUT_MS,
  KIT_LONG_COMMAND_TIMEOUT_MS,
  resolveKitCommandTimeout
} from "../src/kit/kit-command-bridge.js";
import { createWorkflowActionV3Id } from "../src/kit/workflow-action-adapter.js";
import { TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES } from "../src/kit/workflow-action-protocol.js";
import {
  kitContextPackSchema,
  kitGateResultSchema,
  kitIntegrationContractSchema,
  kitStatusSchema
} from "../src/kit/kit-schemas.js";
import {
  authoritativeContextPackFixture,
  createVispShim,
  gateResultFixture,
  policyValidateFixture
} from "./helpers/visp-shim.js";
import { workflowActionV32Fixture } from "./helpers/canonical-action-fixture.js";

const initializedStatus = {
  success: true,
  initialized: true,
  activeFeature: { id: "002", slug: "demo", key: "002-demo" },
  activeTask: { id: "T001", title: "Kit Schemas", status: "ready" },
  featureState: "context_ready",
  // Extra unknown fields that real visp output includes:
  targetPath: "/somewhere",
  taskSummary: { total: 2, ready: 1 }
};

async function createKitProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-kit-project-"));
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  return projectPath;
}

function integrationContractFixture(contractVersion = "2.0") {
  return {
    success: true,
    contractVersion,
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo",
    initialized: true,
    activeFeature: null,
    activeTask: null,
    commands: {},
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
  };
}

function advertisedIntegrationContractFixture(overrides: Record<string, unknown> = {}) {
  return {
    ...integrationContractFixture(),
    activeFeature: {
      id: "001",
      slug: "demo",
      key: "001-demo",
      path: ".visp/features/001-demo"
    },
    activeTask: { id: "T001", title: "Demo task", status: "ready" },
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
    ...overrides
  };
}

function bridgeWorkflowActionV2(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T001",
    goal: "Implement the current task.",
    requiredReads: [],
    writablePaths: ["src/feature.ts"],
    forbiddenPaths: ["package.json"],
    acceptanceOracles: [],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp implement",
    ...overrides
  };
}

function bridgeWorkflowActionV3(overrides: Record<string, unknown> = {}) {
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
    risk: {
      level: { state: "available", value: "medium" },
      factors: unavailable
    },
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

async function createPinnedContextProject(payload: unknown, taskId = "T001") {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-authoritative-ctx-"));
  const contextDir = join(projectPath, ".visp", "features", "001-demo", "context");
  const contextPath = join(contextDir, "T001.context.json");
  await mkdir(contextDir, { recursive: true });
  await writeFile(contextPath, JSON.stringify(payload), "utf8");

  const contract = kitIntegrationContractSchema.parse({
    ...integrationContractFixture(),
    targetPath: projectPath,
    activeFeature: {
      id: "001",
      slug: "demo",
      key: "001-demo",
      path: ".visp/features/001-demo"
    },
    activeTask: { id: taskId, title: "First task", status: "ready" }
  });

  return { projectPath, contextPath, contract };
}

describe("detectVisp", () => {
  it("MODE_HEALTHY: initialized successful Kit is healthy", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({ status: { stdout: initializedStatus } });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({ state: "healthy", available: true });
    if (result.available) {
      expect(result.status.initialized).toBe(true);
      expect(result.status.activeTask?.id).toBe("T001");
    }
  });

  it("MODE_CONFIGURED_UNHEALTHY: missing binary is not Kit absence", async () => {
    const projectPath = await createKitProject();
    const result = await detectVisp(projectPath, {
      binary: join(tmpdir(), "definitely-not-a-real-visp-binary-xyz")
    });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "binary_not_found",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
    if (!result.available) {
      expect(result.reason).toMatch(/not found|unavailable/i);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("MODE_CONFIGURED_UNHEALTHY: status timeout carries a reason", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({
      status: { stdout: initializedStatus, delayMs: 250 }
    });

    const result = await detectVisp(projectPath, { binary: shim.binary, timeoutMs: 20 });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "status_timeout",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
  });

  it("MODE_CONFIGURED_UNHEALTHY: non-zero status is unhealthy even with healthy-looking JSON", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({
      status: { stdout: initializedStatus, exitCode: 1 }
    });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "status_nonzero",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
  });

  it("MODE_CONFIGURED_UNHEALTHY: malformed status carries a reason", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({ status: { stdout: "not json at all" } });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "status_malformed",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
    if (!result.available) {
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("MODE_ABSENT: no Kit signals is genuine absence", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-nokit-"));
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    // Shim would say initialized=true, but without policy.json/project.json the
    // probe must not even be trusted.
    const shim = await createVispShim({ status: { stdout: initializedStatus } });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({
      state: "absent",
      available: false,
      reasonCode: "no_kit_signals"
    });
    if (!result.available) {
      expect(result.reason).toMatch(/no Visp Kit-owned .* artifacts/i);
    }
  });

  it("MODE_CONFIGURED_UNHEALTHY: residual .visp/features is still a Kit signal", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-residual-kit-"));
    await mkdir(join(projectPath, ".visp", "features", "001-residual"), { recursive: true });

    const result = await detectVisp(projectPath, {
      binary: join(tmpdir(), "definitely-not-a-real-visp-binary-residual")
    });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "binary_not_found"
    });
  });

  it("MODE_CONFIGURED_UNHEALTHY: uninitialized status is not Kit absence", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: false } }
    });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "status_uninitialized",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
    if (!result.available) {
      expect(result.reason).toMatch(/not initialized/i);
    }
  });

  it("MODE_CONFIGURED_UNHEALTHY: success false cannot be healthy when initialized is true", async () => {
    const projectPath = await createKitProject();
    const shim = await createVispShim({
      status: { stdout: { ...initializedStatus, success: false } }
    });

    const result = await detectVisp(projectPath, { binary: shim.binary });

    expect(result).toMatchObject({
      state: "configured-unhealthy",
      available: false,
      reasonCode: "status_failed",
      reason: expect.any(String),
      warnings: expect.arrayContaining([expect.any(String)])
    });
  });
});

describe("KitCommandBridge", () => {
  it("P1_07C2: removes obsolete tolerant WorkflowAction v2 consumer symbols", async () => {
    const [bridgeSource, schemaSource, compatibilitySource] = await Promise.all([
      readFile(join(process.cwd(), "src", "kit", "kit-command-bridge.ts"), "utf8"),
      readFile(join(process.cwd(), "src", "kit", "kit-schemas.ts"), "utf8"),
      readFile(join(process.cwd(), "src", "kit", "kit-contract-compat.ts"), "utf8")
    ]);

    expect(bridgeSource).not.toMatch(/\bnextAction(?:Diagnostic)?\s*\(/u);
    expect(schemaSource).not.toContain("export const workflowActionV2Schema");
    expect(schemaSource).not.toContain("export type WorkflowActionV2 =");
    expect(compatibilitySource).not.toContain("SUPPORTED_WORKFLOW_ACTION_VERSION");
    expect(compatibilitySource).not.toContain("unsupportedWorkflowActionWarning");
  });

  it("POLICY_EXACT: preserves live nested validation errors and Kit nextCommand", async () => {
    const policy = policyValidateFixture({
      success: false,
      validation: {
        passed: false,
        errors: ["Policy rule VSP006 requires a task context pack."]
      },
      nextCommand: "visp context --task T001"
    });
    const shim = await createVispShim({ policy: { stdout: policy } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.policyValidate();

    expect(result?.success).toBe(false);
    expect(result?.validation).toMatchObject({
      passed: false,
      errors: ["Policy rule VSP006 requires a task context pack."]
    });
    expect(result?.nextCommand).toBe("visp context --task T001");
    expect(bridge.warnings).toEqual([]);
  });

  it("POLICY_EXACT: accepts an authoritative failed validation from Kit exit 1", async () => {
    const policy = policyValidateFixture({
      success: false,
      validation: { passed: false, errors: ["Policy file is invalid."] },
      nextCommand: "visp policy validate"
    });
    const shim = await createVispShim({
      policy: { stdout: policy, exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.policyValidate();

    expect(result).toMatchObject({
      success: false,
      validation: { passed: false, errors: ["Policy file is invalid."] },
      nextCommand: "visp policy validate"
    });
    expect(bridge.warnings).toEqual([]);
  });

  it("FAIL_CLOSED: rejects contradictory policy success and validation.passed", async () => {
    const shim = await createVispShim({
      policy: {
        stdout: policyValidateFixture({
          success: true,
          validation: { passed: false, errors: ["Contradictory fixture."] }
        })
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.policyValidate();

    expect(result).toBeNull();
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/contradictory success=true.*passed=false/i)])
    );
  });

  it("FAIL_CLOSED: rejects successful policy authority from a nonzero Kit exit", async () => {
    const shim = await createVispShim({
      policy: { stdout: policyValidateFixture(), exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.policyValidate();

    expect(result).toBeNull();
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/exited with code 1.*success=true/i)])
    );
  });

  it("AC003: parses status/verify/review/reconcile/next and passes --json", async () => {
    const shim = await createVispShim({
      status: { stdout: initializedStatus },
      verify: { stdout: { success: true, warnings: ["w"] } },
      review: { stdout: { success: true, errors: [] } },
      reconcile: { stdout: { success: false, errors: ["e"] } },
      next: { stdout: { success: true, nextCommand: "visp pr", state: "ready", allowed: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect((await bridge.status())?.initialized).toBe(true);
    expect((await bridge.verify())?.warnings).toEqual(["w"]);
    expect((await bridge.review())?.success).toBe(true);
    expect((await bridge.reconcile())?.errors).toEqual(["e"]);
    expect((await bridge.next())?.nextCommand).toBe("visp pr");
    expect(bridge.warnings).toEqual([]);

    const log = await readFile(shim.argvLogPath, "utf8");
    for (const line of log.trim().split("\n")) {
      expect(JSON.parse(line)).toContain("--json");
    }
  });

  it.each(["verify", "review", "reconcile"] as const)(
    "FAIL_CLOSED: rejects successful %s evidence from a nonzero Kit exit",
    async (stage) => {
      const shim = await createVispShim({
        [stage]: { stdout: { success: true }, exitCode: 1 }
      });
      const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

      expect(await bridge[stage]("T001")).toBeNull();
      expect(bridge.warnings).toEqual([
        expect.stringContaining("exited with code 1 while reporting success=true")
      ]);
    }
  );

  it("preserves authoritative failed verify evidence from a nonzero Kit exit", async () => {
    const shim = await createVispShim({
      verify: { stdout: { success: false, errors: ["verification failed"] }, exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.verify("T001")).toEqual({
      success: false,
      errors: ["verification failed"]
    });
    expect(bridge.warnings).toEqual([]);
  });

  it("AC004: gate exiting non-zero with valid JSON returns allowed=false without throwing", async () => {
    const shim = await createVispShim({
      gate: {
        stdout: gateResultFixture({
          stage: "implement",
          allowed: false,
          failedRules: [{ ruleId: "VSP006", severity: "error", message: "blocked" }],
          blockedCommands: [{ command: "visp pr", reason: "missing verify", ruleId: "VSP014" }],
          nextAllowedCommand: "Run visp verify.",
          nextCommand: "visp verify"
        }),
        exitCode: 1
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result?.allowed).toBe(false);
    expect(result?.failedRules[0]?.ruleId).toBe("VSP006");
    expect(bridge.warnings).toEqual([]);

    // The real CLI takes the task as a flag; a positional id is parsed as a path.
    const argv = JSON.parse((await readFile(shim.argvLogPath, "utf8")).trim()) as string[];
    expect(argv).toEqual(["gate", "implement", "--task", "T001", "--json"]);
  });

  it("CHECKPOINT_ARGV: verify/review/reconcile pass the task id and reconcile updates traceability", async () => {
    const shim = await createVispShim({
      verify: { stdout: { success: true } },
      review: { stdout: { success: true } },
      reconcile: { stdout: { success: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    await bridge.verify("T009");
    await bridge.review("T009");
    await bridge.reconcile("T009");

    const lines = (await readFile(shim.argvLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines[0]).toEqual(["verify", "--task", "T009", "--json"]);
    expect(lines[1]).toEqual(["review", "--task", "T009", "--json"]);
    expect(lines[2]).toEqual([
      "reconcile",
      "--task",
      "T009",
      "--update-traceability",
      "--json"
    ]);
  });

  it("AC005: unparseable output yields null plus a warning, no exception", async () => {
    const shim = await createVispShim({ verify: { stdout: "<<< not json >>>" } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.verify();

    expect(result).toBeNull();
    expect(bridge.warnings.length).toBeGreaterThan(0);
  });

  it("AC005: gateImplement fails closed on non-JSON gate output (returns null + schema-parse warning)", async () => {
    // Invariant: "unparseable gate results fail closed". A gate is the security
    // boundary, so unparseable output must NOT be treated as allowed.
    const shim = await createVispShim({ gate: { stdout: "<<not json>>" } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toBeNull();
    expect(
      bridge.warnings.some((warning) =>
        warning.includes("could not be parsed against the expected schema")
      )
    ).toBe(true);
  });

  it("AC005: gateImplement fails closed on valid JSON with the wrong shape (schema mismatch)", async () => {
    // `allowed` must be a boolean; the string "yes" violates the schema, so the
    // gate must fail closed (null) rather than coercing a truthy value to allowed.
    const shim = await createVispShim({ gate: { stdout: { allowed: "yes" } } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toBeNull();
  });

  it("AC005: gateImplement returns the parsed result for a well-formed allowed gate body", async () => {
    // Sanity: proves the negative cases above are meaningful — a valid body parses
    // through to a non-null result with allowed === true.
    const shim = await createVispShim({
      gate: { stdout: gateResultFixture({ stage: "implement" }) }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).not.toBeNull();
    expect(result?.allowed).toBe(true);
    expect(bridge.warnings).toEqual([]);
  });

  it("FAIL_CLOSED: rejects an otherwise allowed implement gate for a different task", async () => {
    const shim = await createVispShim({
      gate: {
        stdout: gateResultFixture({ stage: "implement", taskId: "T999" })
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toBeNull();
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/reported taskId=T999; expected taskId=T001/i)
      ])
    );
  });

  it("AUDIT: preserves GateResult warnings, overridden rules, and applied overrides", async () => {
    const appliedOverride = {
      overrideId: "OVR001",
      ruleId: "VSP014",
      scope: "project",
      reason: "Approved test-only Phase 0 exception",
      expiresAt: null,
      appliedToStage: "implement",
      appliedToFeatureId: null,
      appliedToTaskId: null,
      auditSentinel: { source: "kit", retained: true }
    };
    const gateResult = gateResultFixture({
      stage: "implement",
      warnings: ["Human review remains required."],
      overriddenRules: ["VSP014"],
      appliedOverrides: [appliedOverride],
      topLevelAuditSentinel: "retain-me"
    });
    const shim = await createVispShim({
      gate: { stdout: gateResult }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.gateImplement("T001");

    expect(result).toEqual(gateResult);
  });

  it("AC003: recordBudget sends the visp budget flags", async () => {
    const shim = await createVispShim({ budget: { stdout: { success: true } } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const recorded = await bridge.recordBudget({
      taskId: "T001",
      inputTokens: 1200,
      outputTokens: 300,
      model: "claude-code",
      note: "implementation pass"
    });
    expect(recorded?.success).toBe(true);

    const unavailable = await bridge.recordBudget({ taskId: "T002", unavailable: true });
    expect(unavailable?.success).toBe(true);

    const lines = (await readFile(shim.argvLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(lines[0]).toEqual([
      "budget",
      "--task",
      "T001",
      "--record-usage",
      "--input-tokens",
      "1200",
      "--output-tokens",
      "300",
      "--model",
      "claude-code",
      "--usage-note",
      "implementation pass",
      "--json"
    ]);
    expect(lines[1]).toEqual(["budget", "--task", "T002", "--record-usage-unavailable", "--json"]);
  });

  it("parses the visp integration contract when supported", async () => {
    const shim = await createVispShim({
      integration: {
        stdout: {
          success: true,
          contractVersion: "2.0",
          kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.2" },
          targetPath: "/repo",
          initialized: true,
          activeFeature: { id: "001", slug: "demo", key: "001-demo", path: ".visp/features/001-demo" },
          activeTask: { id: "T001", title: "Demo", status: "ready" },
          commands: { status: ["status", "--json"] },
          capabilities: {
            governance: { failClosedGates: true, sourceEditsRequireImplementGate: true },
            contextGrounding: {
              taskScopedContextPacks: true,
              artifactProvenance: true,
              orchestratorReadContract: true
            },
            evidence: { verification: true, review: true, reconciliation: true },
            enforcementSurfaces: { gitPreCommitHook: true, ciPolicyGate: true }
          },
          workflow: {
            strictSequence: ["status", "policyValidate", "gateNext", "context", "gateImplement"],
            failClosedOn: ["policyValidate", "gateImplement"],
            freshnessChecks: [
              ".visp/features/<feature>/context/<task-id>.context.json",
              "contextPack.artifactProvenance[]"
            ],
            humanOverride: { requiresReason: true, artifact: ".visp/overrides.json" }
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
            requiredArtifacts: [
              {
                id: "context-pack",
                path: ".visp/features/001-demo/context/T001.context.json",
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
        }
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const contract = await bridge.integrationContract();

    expect(contract?.contractVersion).toBe("2.0");
    expect(contract?.kit.version).toBe("0.1.2");
    expect(contract?.capabilities?.governance?.failClosedGates).toBe(true);
    expect(contract?.capabilities?.contextGrounding?.artifactProvenance).toBe(true);
    expect(contract?.capabilities?.contextGrounding?.orchestratorReadContract).toBe(true);
    expect(contract?.orchestrator?.readContractVersion).toBe("0.1");
    expect(contract?.orchestrator?.requiredArtifacts?.[0]?.id).toBe("context-pack");
    expect(contract?.workflow?.failClosedOn).toContain("gateImplement");
    expect(contract?.workflow?.freshnessChecks).toContain("contextPack.artifactProvenance[]");
    const argv = JSON.parse((await readFile(shim.argvLogPath, "utf8")).trim()) as string[];
    expect(argv).toEqual(["integration", "contract", "--json"]);
  });

  it.each(["1.3", "3.0"])(
    "FAIL_CLOSED: rejects unsupported integration contract version %s",
    async (contractVersion) => {
      const shim = await createVispShim({
        integration: { stdout: integrationContractFixture(contractVersion) }
      });
      const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

      const contract = await bridge.integrationContract();

      expect(contract).toBeNull();
      expect(bridge.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(new RegExp(contractVersion.replace(".", "\\.")))])
      );
    }
  );

  it("AUDIT: preserves a negotiated blocked WorkflowAction 2.0 from a nonzero Kit exit", async () => {
    const action = bridgeWorkflowActionV2({
      taskId: null,
      goal: "Project scan cache is missing or incomplete.",
      writablePaths: [],
      validationCommands: [],
      verdict: "blocked",
      findings: ["VSP001: Project scan is required."],
      nextCommand: "visp scan"
    });
    const shim = await createVispShim({
      integration: { stdout: integrationContractFixture() },
      next: { stdout: action, exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.nextCanonicalActionDiagnostic("2.0");

    expect(result).toMatchObject({
      ok: true,
      value: {
        source: { protocolVersion: "2.0", selectionMode: "legacy_v2" },
        task: null,
        verdict: "blocked",
        nextCommand: "visp scan"
      }
    });
    expect(bridge.warnings).toEqual([]);
  });

  it("FAIL_CLOSED: rejects a negotiated ready WorkflowAction 2.0 from a nonzero Kit exit", async () => {
    const action = bridgeWorkflowActionV2();
    const shim = await createVispShim({
      integration: { stdout: integrationContractFixture() },
      next: { stdout: action, exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.nextCanonicalActionDiagnostic("2.0");

    expect(result).toMatchObject({ ok: false, reasonCode: "workflow_action_contradiction" });
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/exited with code 1.*verdict=ready/i)])
    );
  });

  it("P1_06_AUTO: negotiates advertised v3 and invokes the exact selected protocol", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV3() }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.nextCanonicalActionDiagnostic();

    expect(result).toMatchObject({
      ok: true,
      value: {
        source: {
          protocolVersion: "3.0",
          selectionMode: "advertised",
          localSchemaHash: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.0"],
          schemaHashVerification: { state: "advertised_verified" }
        },
        task: { id: "T001" },
        verdict: "ready"
      }
    });
    expect(bridge.warnings).toEqual([]);
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"]
    ]);
  });

  it("P1_06_AUTO_V2: auto selects the only mutually advertised v2 protocol", async () => {
    const contract = advertisedIntegrationContractFixture({
      protocols: {
        workflowAction: {
          supported: ["2.0"],
          default: "2.0",
          schemaHashes: { "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"] }
        }
      }
    });
    const shim = await createVispShim({
      integration: { stdout: contract },
      next: { stdout: bridgeWorkflowActionV2() }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: true,
      value: { source: { protocolVersion: "2.0", selectionMode: "advertised" } }
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "2.0", "--json"]
    ]);
  });

  it("P1_06_EXPLICIT_V3: explicit v3 invokes the exact selected protocol", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV3() }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic("3.0")).toMatchObject({
      ok: true,
      value: { source: { protocolVersion: "3.0", selectionMode: "advertised" } }
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"]
    ]);
  });

  it("P1_06_LEGACY: explicit v2 uses selector-less legacy invocation", async () => {
    const shim = await createVispShim({
      integration: { stdout: integrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV2({ taskId: null, writablePaths: [] }) }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    const result = await bridge.nextCanonicalActionDiagnostic("2.0");

    expect(result).toMatchObject({
      ok: true,
      value: {
        source: {
          protocolVersion: "2.0",
          selectionMode: "legacy_v2",
          schemaHashVerification: { state: "legacy_unadvertised" }
        },
        task: null
      }
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
  });

  it("P1_06_LEGACY_AUTO: auto uses selector-less v2 for an unadvertised contract", async () => {
    const shim = await createVispShim({
      integration: { stdout: integrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV2({ taskId: null, writablePaths: [] }) }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: true,
      value: {
        source: {
          protocolVersion: "2.0",
          selectionMode: "legacy_v2",
          schemaHashVerification: { state: "legacy_unadvertised" }
        }
      }
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
  });

  it("P1_06_EXPLICIT: advertised v2 requests the exact protocol without downgrade", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV2() }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic("2.0")).toMatchObject({
      ok: true,
      value: { source: { protocolVersion: "2.0", selectionMode: "advertised" } }
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv[1]).toEqual([
      "next",
      "--format",
      "json",
      "--protocol",
      "2.0",
      "--json"
    ]);
  });

  it("P1_06_FAIL_CLOSED: invalid advertisement stops before next", async () => {
    const contract: Record<string, unknown> = advertisedIntegrationContractFixture();
    contract.protocols = {
      workflowAction: {
        supported: ["3.0", "3.0"],
        default: "3.0",
        schemaHashes: { "3.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.0"] }
      }
    };
    const shim = await createVispShim({ integration: { stdout: contract } });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_advertisement_invalid"
    });
    expect((await readFile(shim.argvLogPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it.each([
    {
      label: "present-null protocols",
      contract: advertisedIntegrationContractFixture({ protocols: null }),
      preference: "auto" as const,
      reasonCode: "workflow_action_advertisement_invalid"
    },
    {
      label: "empty supported set",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: { supported: [], default: "2.0", schemaHashes: {} }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_advertisement_invalid"
    },
    {
      label: "default outside supported set",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["2.0"],
            default: "3.0",
            schemaHashes: { "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"] }
          }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_advertisement_invalid"
    },
    {
      label: "incomplete hash key set",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["2.0", "3.0"],
            default: "2.0",
            schemaHashes: { "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"] }
          }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_advertisement_invalid"
    },
    {
      label: "malformed hash",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["2.0"],
            default: "2.0",
            schemaHashes: { "2.0": "sha256:ABC" }
          }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_advertisement_invalid"
    },
    {
      label: "no mutually supported protocol",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["4.0"],
            default: "4.0",
            schemaHashes: { "4.0": `sha256:${"4".repeat(64)}` }
          }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_no_mutual_protocol"
    },
    {
      label: "explicit v3 without downgrade",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["2.0"],
            default: "2.0",
            schemaHashes: { "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"] }
          }
        }
      }),
      preference: "3.0" as const,
      reasonCode: "workflow_action_no_mutual_protocol"
    },
    {
      label: "selected hash mismatch without downgrade",
      contract: advertisedIntegrationContractFixture({
        protocols: {
          workflowAction: {
            supported: ["2.0", "3.0"],
            default: "2.0",
            schemaHashes: {
              "2.0": TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["2.0"],
              "3.0": `sha256:${"0".repeat(64)}`
            }
          }
        }
      }),
      preference: "auto" as const,
      reasonCode: "workflow_action_schema_hash_mismatch"
    },
    {
      label: "unexpected Kit identity",
      contract: advertisedIntegrationContractFixture({
        kit: { packageName: "lookalike-kit", cliName: "visp", version: "0.1.1" }
      }),
      preference: "auto" as const,
      reasonCode: "unsupported_integration_contract"
    }
  ])(
    "P1_06_PREFLIGHT: $label stops before next",
    async ({ contract, preference, reasonCode }) => {
      const shim = await createVispShim({ integration: { stdout: contract } });
      const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

      expect(await bridge.nextCanonicalActionDiagnostic(preference)).toMatchObject({
        ok: false,
        reasonCode
      });
      const argv = (await readFile(shim.argvLogPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(argv).toEqual([["integration", "contract", "--json"]]);
    }
  );

  it("P1_06_FAIL_CLOSED: rejects a response protocol different from selection", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV2() }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_protocol_mismatch"
    });
  });

  it("P3_08_FAIL_CLOSED: does not downgrade after selected 3.2 schema validation fails", async () => {
    const contract = advertisedIntegrationContractFixture({
      protocols: {
        workflowAction: {
          supported: ["2.0", "3.0", "3.1", "3.2"],
          default: "2.0",
          schemaHashes: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES
        }
      }
    });
    const shim = await createVispShim({
      integration: { stdout: contract },
      next: { stdout: { ...workflowActionV32Fixture(), unexpected: true } }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_schema_invalid"
    });
    const argv = (await readFile(shim.argvLogPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(argv).toEqual([
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.2", "--json"]
    ]);
  });

  it("P1_06_FAIL_CLOSED: maps Kit's structured unsupported-protocol error", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: {
        stdout: {
          success: false,
          error: {
            code: "UNSUPPORTED_WORKFLOW_ACTION_PROTOCOL",
            requested: "3.0",
            supported: ["2.0"],
            default: "2.0"
          }
        },
        exitCode: 1
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "unsupported_workflow_action"
    });
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["strict-schema extra field", { ...bridgeWorkflowActionV3(), unexpected: true }]
  ])("P1_06_FAIL_CLOSED: rejects %s action output", async (_label, stdout) => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_schema_invalid"
    });
  });

  it("P1_06_FAIL_CLOSED: rejects contract/action identity races", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV3({ task: null }) }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_contradiction"
    });
  });

  it("P1_06_FAIL_CLOSED: rejects v3 feature identity races", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV3({ feature: { id: "002", slug: "other" } }) }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_contradiction"
    });
  });

  it("P1_06_FAIL_CLOSED: rejects a negotiated ready action from a nonzero process", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: { stdout: bridgeWorkflowActionV3(), exitCode: 1 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic()).toMatchObject({
      ok: false,
      reasonCode: "workflow_action_contradiction"
    });
  });

  it("P1_06_AUTHORITY: preserves a coherent blocked negotiated v2 action from exit 1", async () => {
    const shim = await createVispShim({
      integration: { stdout: advertisedIntegrationContractFixture() },
      next: {
        stdout: bridgeWorkflowActionV2({
          verdict: "blocked",
          findings: ["VSP001: Blocked."],
          writablePaths: []
        }),
        exitCode: 1
      }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect(await bridge.nextCanonicalActionDiagnostic("2.0")).toMatchObject({
      ok: true,
      value: { verdict: "blocked", findingMessages: ["VSP001: Blocked."] }
    });
  });

  it.each([
    ["blocked", "blocks", "error"],
    ["inconclusive", "uncertain", "warning"]
  ] as const)(
    "P1_06_AUTHORITY: preserves coherent v3 %s from a nonzero Kit exit",
    async (verdict, effect, severity) => {
      const action = bridgeWorkflowActionV3({
        verdict,
        findings: [
          {
            code: `VISP.TEST.${effect.toUpperCase()}`,
            source: "workflow",
            severity,
            effect,
            message: `The action is ${verdict}.`,
            recommendation: "Follow the authoritative next command.",
            evidence: []
          }
        ],
        nextCommand: verdict === "blocked" ? "visp scan" : "visp clarify"
      });
      const shim = await createVispShim({
        integration: { stdout: advertisedIntegrationContractFixture() },
        next: { stdout: action, exitCode: 1 }
      });
      const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

      expect(await bridge.nextCanonicalActionDiagnostic("3.0")).toMatchObject({
        ok: true,
        value: { verdict, structuredFindings: { state: "available" } }
      });
    }
  );

  it("CONTEXT_EXACT: reads a complete authoritative context artifact from the pinned contract path", async () => {
    const context = authoritativeContextPackFixture({
      auditSentinel: { source: "kit", retained: true }
    });
    const { projectPath, contextPath, contract } = await createPinnedContextProject(context);
    const bridge = new KitCommandBridge({ projectPath });

    const artifact = await bridge.readAuthoritativeContextPackArtifact("T001", contract);

    expect(artifact?.path).toBe(contextPath);
    expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact?.pack).toEqual(context);
    expect(bridge.warnings).toEqual([]);
  });

  it("FAIL_CLOSED: rejects valid JSON with only the legacy tolerant context shape", async () => {
    const { projectPath, contract } = await createPinnedContextProject({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "Legacy partial shape." }],
      validationCommands: ["pnpm test"]
    });
    const bridge = new KitCommandBridge({ projectPath });

    const artifact = await bridge.readAuthoritativeContextPackArtifact("T001", contract);

    expect(artifact).toBeNull();
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/could not be parsed/i)])
    );
  });

  it("FAIL_CLOSED: rejects an authoritative context artifact for a different task", async () => {
    const context = authoritativeContextPackFixture({ taskId: "T999" });
    const { projectPath, contract } = await createPinnedContextProject(context);
    const bridge = new KitCommandBridge({ projectPath });

    const artifact = await bridge.readAuthoritativeContextPackArtifact("T001", contract);

    expect(artifact).toBeNull();
    expect(bridge.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/reported taskId=T999; expected T001/i)])
    );
  });

  it("AC003: readContextPack reads and parses a fixture context pack file", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-ctx-"));
    const contextDir = join(projectPath, ".visp", "features", "001-x", "context");
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, "T001.context.json"),
      JSON.stringify({
        taskId: "T001",
        includedFiles: [{ path: "src/kit/kit-schemas.ts", reason: "new file" }],
        validationCommands: ["pnpm typecheck"],
        // unknown extra field:
        strictnessMode: "strict"
      }),
      "utf8"
    );

    // status responds with no active feature so the scan path is exercised.
    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: true } }
    });
    const bridge = new KitCommandBridge({ projectPath, binary: shim.binary });

    const pack = await bridge.readContextPack("T001");

    expect(pack?.taskId).toBe("T001");
    expect(pack?.includedFiles?.[0]?.path).toBe("src/kit/kit-schemas.ts");
    expect(bridge.warnings).toEqual([]);
  });

  it("readContextPack prefers the integration contract path when present", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-ctx-contract-"));
    const contextDir = join(projectPath, ".visp", "contract-context");
    await mkdir(contextDir, { recursive: true });
    await writeFile(
      join(contextDir, "T777.context.json"),
      JSON.stringify({
        taskId: "T777",
        includedFiles: [{ path: "src/from-contract.ts", reason: "contract path" }]
      }),
      "utf8"
    );
    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: true } },
      integration: {
        stdout: {
          success: true,
          contractVersion: "2.0",
          kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.2" },
          targetPath: projectPath,
          initialized: true,
          activeFeature: { id: "001", slug: "demo", key: "001-demo", path: ".visp/features/001-demo" },
          activeTask: { id: "T777", title: "Demo", status: "ready" },
          commands: {},
          artifacts: {
            kitSignals: [".visp/policy.json", ".visp/project.json"],
            projectStatus: ".visp/status.json",
            projectProfile: ".visp/project.json",
            featureRoot: ".visp/features",
            featureDir: ".visp/features/001-demo",
            taskGraph: ".visp/features/001-demo/task-graph.json",
            contextPack: ".visp/contract-context/T777.context.json",
            contextPrompt: ".visp/contract-context/T777.prompt.md"
          },
          warnings: []
        }
      }
    });
    const bridge = new KitCommandBridge({ projectPath, binary: shim.binary });

    const pack = await bridge.readContextPack("T777");

    expect(pack?.includedFiles?.[0]?.path).toBe("src/from-contract.ts");
    expect(bridge.warnings).toEqual([]);
  });
});

describe("kit-schemas tolerance (AC006)", () => {
  it("parses realistic status payloads with extra unknown fields", () => {
    const parsed = kitStatusSchema.safeParse(initializedStatus);
    expect(parsed.success).toBe(true);
  });

  it("rejects legacy bare-string failedRules outside the exact current GateResult", () => {
    const parsed = kitGateResultSchema.safeParse({
      ...gateResultFixture({ stage: "feature", allowed: false }),
      failedRules: ["VSP018"],
      nextAllowedCommand: "Run visp policy validate.",
      nextCommand: "visp policy validate"
    });
    expect(parsed.success).toBe(false);
  });

  it("gives long-running Kit commands a budget larger than the artifact-read default", () => {
    // Kit allows 120s per validation command and may run several in one process, so
    // the 10s default killed `visp verify` on any repository with a real test suite
    // and the checkpoint reported INCONCLUSIVE forever.
    expect(KIT_LONG_COMMAND_TIMEOUT_MS).toBeGreaterThan(KIT_DEFAULT_TIMEOUT_MS);
    expect(KIT_LONG_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);

    expect(resolveKitCommandTimeout({ configuredMs: undefined, longRunning: true })).toBe(
      KIT_LONG_COMMAND_TIMEOUT_MS
    );
  });

  it("leaves short Kit commands on the default budget so the guard hot path stays fast", () => {
    // `guard` runs on the PreToolUse hook for every tool call. A hung Kit must surface
    // in seconds there, not stall every edit for the long budget.
    expect(resolveKitCommandTimeout({ configuredMs: undefined, longRunning: false })).toBeUndefined();
  });

  it("lets an explicitly configured timeout win, including for long-running commands", () => {
    // Tests and callers that deliberately pass a short timeout must keep it; the
    // per-command budget only applies when the bridge fell back to its default.
    expect(resolveKitCommandTimeout({ configuredMs: 20, longRunning: true })).toBeUndefined();
    expect(resolveKitCommandTimeout({ configuredMs: 20, longRunning: false })).toBeUndefined();
  });

  it("an explicit short timeout still times out a slow verify", async () => {
    const shim = await createVispShim({
      verify: { stdout: { success: true, warnings: [] }, delayMs: 250 }
    });
    const bridge = new KitCommandBridge({
      projectPath: process.cwd(),
      binary: shim.binary,
      timeoutMs: 20
    });

    expect(await bridge.verify()).toBeNull();
    expect(bridge.warnings.join(" ")).toMatch(/timed out/i);
  });

  it("a default bridge completes a verify that outlives a short explicit budget", async () => {
    const shim = await createVispShim({
      verify: { stdout: { success: true, warnings: ["slow but finished"] }, delayMs: 250 }
    });
    const bridge = new KitCommandBridge({ projectPath: process.cwd(), binary: shim.binary });

    expect((await bridge.verify())?.warnings).toEqual(["slow but finished"]);
    expect(bridge.warnings).toEqual([]);
  });

  it("parses context packs with includedFiles and unknown fields", () => {
    const parsed = kitContextPackSchema.safeParse({
      id: "CTX-T001",
      featureId: "002",
      taskId: "T001",
      includedFiles: [{ path: "a.ts", reason: "x", includeMode: "new-file" }],
      includedSnippets: [],
      validationCommands: ["pnpm test"]
    });
    expect(parsed.success).toBe(true);
  });
});
