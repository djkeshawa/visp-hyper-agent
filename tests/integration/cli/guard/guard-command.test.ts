import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../../src/cli/index.js";
import { execFileResolved } from "../../../../src/core/executable-resolver.js";
import { initializeProject } from "../../../../src/core/session-manager.js";
import { checkScope, collectChangedFiles } from "../../../../src/governance/scope-guard.js";
import { createWorkflowActionV3Id } from "../../../../src/kit/workflow-action-adapter.js";
import type { WorkflowActionV3Wire } from "../../../../src/kit/workflow-action-protocol.js";
import { toolOnlyPath } from "../../../helpers/tool-path.js";
import { createVispShim, type ShimSpec, type VispShim } from "../../../helpers/visp-shim.js";

// Resolve every helper's git call the same way the product does, so bare
// commands still spawn when the test replaces PATH with an isolated tool dir.
const execFileAsync = execFileResolved;

const originalPath = process.env.PATH;
const V2_HASH =
  "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6";
const V3_HASH =
  "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7";
const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });
const notApplicable = (
  reasonCode: "no_active_task" | "stage_does_not_require_value" =
    "stage_does_not_require_value"
) => ({ state: "not_applicable" as const, reasonCode });

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await commit(projectPath, "init");
}

async function commit(projectPath: string, message: string): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", message],
    { cwd: projectPath }
  );
}

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await gitInit(projectPath);
  return projectPath;
}

async function stage(projectPath: string, file: string): Promise<void> {
  await execFileAsync("git", ["add", file], { cwd: projectPath });
}

/**
 * A PATH directory exposing git + node but no `visp` binary, so the kit-less
 * branch is exercised (mirrors local-evidence.test.ts technique).
 */
async function gitNodeOnlyPath(): Promise<string> {
  return toolOnlyPath(["git"]);
}

function workflowActionFixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T900",
    goal: "Use the authoritative guard scope",
    requiredReads: [],
    writablePaths: ["src"],
    forbiddenPaths: [],
    acceptanceOracles: [],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp implement",
    ...overrides
  };
}

function integrationContractFixture(contractVersion = "2.0", protocols?: unknown) {
  return {
    success: true,
    contractVersion,
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo",
    initialized: true,
    activeFeature: {
      id: "001",
      slug: "strict-guard",
      key: "001-strict-guard",
      path: ".visp/features/001-strict-guard"
    },
    activeTask: { id: "T900", title: "Guard scope", status: "ready" },
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
      featureDir: ".visp/features/001-strict-guard",
      taskGraph: ".visp/features/001-strict-guard/task-graph.json",
      contextPack: ".visp/features/001-strict-guard/context/T900.context.json",
      contextPrompt: ".visp/features/001-strict-guard/context/T900.prompt.md"
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

function advertisedIntegrationContractFixture(protocols: readonly ("2.0" | "3.0")[]) {
  return integrationContractFixture("2.0", {
    workflowAction: {
      supported: protocols,
      default: protocols[protocols.length - 1],
      schemaHashes: Object.fromEntries(
        protocols.map((protocol) => [protocol, protocol === "3.0" ? V3_HASH : V2_HASH])
      )
    }
  });
}

function workflowActionV3Fixture(
  overrides: Record<string, unknown> = {}
): WorkflowActionV3Wire {
  const draft = {
    protocolVersion: "3.0" as const,
    canonicalVersion: "1.0" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    phase: "implement" as const,
    feature: { id: "001", slug: "strict-guard" },
    task: {
      id: "T900",
      title: "Guard scope",
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
    goal: "Use the authoritative guard scope",
    baseCommit: unavailable("not_captured"),
    requiredReads: [],
    scope: {
      writablePaths: ["src"],
      expectedPaths: unavailable(),
      forbiddenPaths: [],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [],
    validationCommands: ["pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid" as const), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready" as const,
    nextCommand: "visp implement --task T900",
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  } as WorkflowActionV3Wire;
}

function healthyKitSpec(extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        initialized: true,
        activeFeature: { id: "001", slug: "strict-guard" },
        activeTask: { id: "T900", title: "Guard scope", status: "ready" }
      }
    },
    integration: { stdout: integrationContractFixture() },
    next: { stdout: workflowActionFixture() },
    ...extra
  };
}

async function configureKit(
  projectPath: string,
  spec: ShimSpec = healthyKitSpec()
): Promise<VispShim> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const shim = await createVispShim(spec);
  process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
  return shim;
}

async function readArgvLog(path: string): Promise<string[][]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

type RenderedActionEnvelope = {
  frameVersion: string;
  authority: string;
  action: {
    source: { protocolVersion: string; selectionMode: string };
    task: null | { id: string };
    scope: { writablePaths: string[]; forbiddenPaths: string[] };
    verdict: string;
    wire?: unknown;
  };
};

function readActionEnvelope(output: string): RenderedActionEnvelope {
  const lines = output.split("\n");
  const begin = lines.indexOf("BEGIN_VISP_HYPER_ACTION_V1");
  const end = lines.indexOf("END_VISP_HYPER_ACTION_V1");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBe(begin + 2);
  return JSON.parse(lines[begin + 1]) as RenderedActionEnvelope;
}

function expectGuardResultThenExactAction(output: string): RenderedActionEnvelope {
  expect(output.match(/BEGIN_VISP_GUARD_RESULT/gu)).toHaveLength(1);
  expect(output.match(/END_VISP_GUARD_RESULT/gu)).toHaveLength(1);
  expect(output.match(/BEGIN_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
  expect(output.match(/END_VISP_HYPER_ACTION_V1/gu)).toHaveLength(1);
  expect(output).toContain("END_VISP_GUARD_RESULT\n\nBEGIN_VISP_HYPER_ACTION_V1");
  expect(output.endsWith("END_VISP_HYPER_ACTION_V1")).toBe(true);
  const envelope = readActionEnvelope(output);
  expect(Object.keys(envelope)).toEqual(["frameVersion", "authority", "action"]);
  expect(envelope).toMatchObject({ frameVersion: "1.0", authority: "kit" });
  expect(envelope.action).not.toHaveProperty("wire");
  return envelope;
}

/**
 * Write a hyper state with an active quick-style session whose pipeline declares
 * a single synthetic task (no on-disk task graph).
 */
async function writeQuickSession(
  projectPath: string,
  task: { id: string; allowedFiles?: string[] }
): Promise<void> {
  await initializeProject(projectPath);
  const now = new Date().toISOString();
  const sessionId = "vh_20260612_test0001";
  const state = {
    activeSessionId: sessionId,
    sessions: {
      [sessionId]: {
        id: sessionId,
        goal: "quick task",
        tool: "codex",
        projectPath,
        createdAt: now,
        updatedAt: now,
        phase: "implementation",
        relevantFiles: [],
        pipeline: {
          taskIds: [task.id],
          currentTaskId: task.id,
          completed: [],
          stepHistory: [],
          syntheticTasks: [{ id: task.id, dependsOn: [], allowedFiles: task.allowedFiles }]
        }
      }
    }
  };
  await writeFile(
    join(projectPath, ".visp", "hyper", "state.json"),
    JSON.stringify(state, null, 2),
    "utf8"
  );
}

describe("checkScope", () => {
  it("flags a blocked path even with no allow list", () => {
    const violations = checkScope([".env"], { blockedPaths: [".env"] });
    expect(violations).toEqual([{ file: ".env", rule: "blocked-path" }]);
  });

  it("flags a blocked path that takes precedence over allow list", () => {
    const violations = checkScope(["node_modules/x.js"], {
      allowedFiles: ["node_modules"],
      blockedPaths: ["node_modules"]
    });
    expect(violations).toEqual([{ file: "node_modules/x.js", rule: "blocked-path" }]);
  });

  it("does not check outside-allowed when allowedFiles is empty or absent", () => {
    expect(checkScope(["lib/x.ts"], { blockedPaths: [] })).toEqual([]);
    expect(checkScope(["lib/x.ts"], { allowedFiles: [], blockedPaths: [] })).toEqual([]);
  });

  it("flags outside-allowed only when an allow list is present", () => {
    const violations = checkScope(["lib/x.ts"], { allowedFiles: ["src"], blockedPaths: [] });
    expect(violations).toEqual([{ file: "lib/x.ts", rule: "outside-allowed" }]);
  });

  it("matches allowed entries by exact, prefix, and trailing slash", () => {
    const blockedPaths: string[] = [];
    // exact
    expect(
      checkScope(["src/a.ts"], { allowedFiles: ["src/a.ts"], blockedPaths })
    ).toEqual([]);
    // <entry>/ prefix
    expect(checkScope(["src/a.ts"], { allowedFiles: ["src"], blockedPaths })).toEqual([]);
    // trailing slash
    expect(checkScope(["src/a.ts"], { allowedFiles: ["src/"], blockedPaths })).toEqual([]);
    // a sibling that shares a prefix string but not a path boundary is OUT
    expect(checkScope(["srcother/a.ts"], { allowedFiles: ["src"], blockedPaths })).toEqual([
      { file: "srcother/a.ts", rule: "outside-allowed" }
    ]);
  });
});

describe("collectChangedFiles", () => {
  it("staged returns only staged files", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "staged.ts"), "export const s = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    // An unstaged working-tree change that must NOT appear in staged mode.
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    const result = await collectChangedFiles(projectPath, { mode: "staged" });
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual(["src/staged.ts"]);
  });

  it("all returns the union of staged and working-tree changes", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "staged.ts"), "export const s = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    const result = await collectChangedFiles(projectPath, { mode: "all" });
    expect(result.warnings).toEqual([]);
    expect(new Set(result.files)).toEqual(new Set(["src/staged.ts", "src/feature.ts"]));
  });

  it("base returns files committed on a branch off the base ref", async () => {
    const projectPath = await createRepo();
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: projectPath });
    await writeFile(join(projectPath, "src", "branch.ts"), "export const b = 1;\n", "utf8");
    await stage(projectPath, "src/branch.ts");
    await commit(projectPath, "branch work");

    const result = await collectChangedFiles(projectPath, { mode: "base", baseRef: "main" });
    expect(result.warnings).toEqual([]);
    expect(result.files).toEqual(["src/branch.ts"]);
  });

  it("a non-git directory degrades to empty files plus a warning", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-nogit-"));
    const result = await collectChangedFiles(projectPath, { mode: "all" });
    expect(result.files).toEqual([]);
    expect(result.warnings.length).toBe(1);
  });
});

describe("guard command integration", () => {
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

  it("AC001: staged out-of-scope file is BLOCKED with exit code 1", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: Q001");
    expect(output).toContain("status: BLOCKED");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(process.exitCode).toBe(1);
  });

  it("AC001: staged in-scope file is PASSED with no error exit code", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: Q001");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("- none");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC002: no session/pipeline reports scope none and passes an ordinary file", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    await writeFile(join(projectPath, "src", "ordinary.ts"), "export const o = 1;\n", "utf8");
    await stage(projectPath, "src/ordinary.ts");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: none");
    expect(output).toContain("status: PASSED");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC002: blocked paths apply even with no session", async () => {
    const projectPath = await createRepo();
    await initializeProject(projectPath);
    await writeFile(join(projectPath, ".env"), "SECRET=1\n", "utf8");
    await stage(projectPath, ".env");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: none");
    expect(output).toContain("status: BLOCKED");
    expect(output).toContain(".env: blocked path");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: --base picks up files committed on a branch", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: projectPath });
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await stage(projectPath, "lib/rogue.ts");
    await commit(projectPath, "rogue commit");

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard", "--base", "main"]);

    const output = logs.join("\n");
    expect(output).toContain("checked: 1 file(s) (base main)");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(process.exitCode).toBe(1);
  });

  it("AC003: a non-git directory degrades open with a warning and PASSES", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-nogit-"));
    await initializeProject(projectPath);

    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("warning:");
    expect(output).toContain("status: PASSED");
    expect(process.exitCode).toBeFalsy();
  });

  it.each([
    {
      name: "advertised v3",
      contract: advertisedIntegrationContractFixture(["2.0", "3.0"]),
      action: workflowActionV3Fixture(),
      protocolVersion: "3.0",
      selectionMode: "advertised",
      nextArgv: ["next", "--format", "json", "--protocol", "3.0", "--json"]
    },
    {
      name: "advertised v2",
      contract: advertisedIntegrationContractFixture(["2.0"]),
      action: workflowActionFixture(),
      protocolVersion: "2.0",
      selectionMode: "advertised",
      nextArgv: ["next", "--format", "json", "--protocol", "2.0", "--json"]
    },
    {
      name: "legacy v2",
      contract: integrationContractFixture(),
      action: workflowActionFixture(),
      protocolVersion: "2.0",
      selectionMode: "legacy_v2",
      nextArgv: ["next", "--format", "json", "--json"]
    }
  ])(
    "AC001: configured guard consumes canonical $name scope and renders result then action",
    async ({ contract, action, protocolVersion, selectionMode, nextArgv }) => {
      const projectPath = await createRepo();
      await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
      await stage(projectPath, "src/ok.ts");
      const shim = await configureKit(
        projectPath,
        healthyKitSpec({ integration: { stdout: contract }, next: { stdout: action } })
      );

      await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

      const output = logs.join("\n");
      expect(output).toContain("scope: T900");
      expect(output).toContain("status: PASSED");
      const envelope = expectGuardResultThenExactAction(output);
      expect(envelope.action).toMatchObject({
        source: { protocolVersion, selectionMode },
        task: { id: "T900" },
        scope: { writablePaths: ["src"], forbiddenPaths: [] },
        verdict: "ready"
      });
      expect(await readArgvLog(shim.argvLogPath)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        nextArgv
      ]);
      expect(process.exitCode).toBeFalsy();
    }
  );

  it("AC001: configured guard accepts canonical taskless scope", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(
      projectPath,
      healthyKitSpec({
        status: {
          stdout: {
            success: true,
            initialized: true,
            activeFeature: { id: "001", slug: "strict-guard" },
            activeTask: null
          }
        },
        integration: {
          stdout: {
            ...advertisedIntegrationContractFixture(["3.0"]),
            activeTask: null
          }
        },
        next: {
          stdout: workflowActionV3Fixture({
            phase: "pr",
            task: null,
            taskClass: notApplicable("no_active_task"),
            risk: {
              level: notApplicable("no_active_task"),
              factors: notApplicable("no_active_task")
            },
            goal: "Prepare the pull request",
            scope: {
              writablePaths: ["src"],
              expectedPaths: notApplicable(),
              forbiddenPaths: [],
              operationLimits: notApplicable()
            },
            claims: notApplicable(),
            validationOracles: [],
            validationCommands: [],
            requiredEvidence: notApplicable(),
            nextCommand: "visp pr"
          })
        }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: none");
    expect(output).toContain("status: PASSED");
    const action = expectGuardResultThenExactAction(output).action;
    expect(action).toMatchObject({
      phase: { state: "available", value: "pr" },
      task: null,
      taskClass: { state: "not_applicable", reasonCode: "no_active_task" },
      risk: {
        level: { state: "not_applicable", reasonCode: "no_active_task" },
        factors: { state: "not_applicable", reasonCode: "no_active_task" }
      },
      scope: {
        writablePaths: ["src"],
        expectedPaths: {
          state: "not_applicable",
          reasonCode: "stage_does_not_require_value"
        },
        forbiddenPaths: [],
        operationLimits: {
          state: "not_applicable",
          reasonCode: "stage_does_not_require_value"
        }
      },
      claims: {
        state: "not_applicable",
        reasonCode: "stage_does_not_require_value"
      },
      validationCommands: [],
      requiredEvidence: {
        state: "not_applicable",
        reasonCode: "stage_does_not_require_value"
      },
      verdict: "ready"
    });
    expect(process.exitCode).toBeFalsy();
  });

  it("AC003: configured guard --all evaluates staged and unstaged files against canonical scope", async () => {
    const projectPath = await createRepo();
    const shim = await configureKit(projectPath);
    await stage(projectPath, ".visp/policy.json");
    await commit(projectPath, "configure kit");
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard", "--all"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: T900");
    expect(output).toContain("checked: 2 file(s) (all)");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(expectGuardResultThenExactAction(output).action).toMatchObject({
      scope: { writablePaths: ["src"], forbiddenPaths: [] },
      verdict: "ready"
    });
    expect(await readArgvLog(shim.argvLogPath)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("AC003: configured guard --base evaluates committed files against canonical scope", async () => {
    const projectPath = await createRepo();
    const shim = await configureKit(projectPath);
    await stage(projectPath, ".visp/policy.json");
    await commit(projectPath, "configure kit");
    await execFileAsync("git", ["checkout", "-b", "feature"], { cwd: projectPath });
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await stage(projectPath, "lib/rogue.ts");
    await commit(projectPath, "branch changes");

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "guard",
      "--base",
      "main"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("scope: T900");
    expect(output).toContain("checked: 2 file(s) (base main)");
    expect(output).toContain("lib/rogue.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expect(expectGuardResultThenExactAction(output).action).toMatchObject({
      scope: { writablePaths: ["src"], forbiddenPaths: [] },
      verdict: "ready"
    });
    expect(await readArgvLog(shim.argvLogPath)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
    expect(process.exitCode).toBe(1);
  });

  it("AC001: configured guard ignores conflicting local session and config scope", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["lib"] });
    await writeFile(
      join(projectPath, ".visp", "hyper", "config.json"),
      `${JSON.stringify({
        defaultTool: "generic",
        tokenBudget: 12000,
        memoryMode: "file",
        memoryEndpoint: "http://localhost:8000",
        contextMode: "deterministic",
        blockedPaths: ["src"],
        skillMode: "review"
      })}\n`,
      "utf8"
    );
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await configureKit(projectPath);

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("scope: T900");
    expect(output).toContain("status: PASSED");
    expect(output).not.toContain("scope: Q001");
    expectGuardResultThenExactAction(output);
    expect(process.exitCode).toBeFalsy();
  });

  it("AC003: configured guard applies Kit forbidden paths inside writable scope", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "secret.ts"), "export const secret = 1;\n", "utf8");
    await stage(projectPath, "src/secret.ts");
    await configureKit(
      projectPath,
      healthyKitSpec({
        next: {
          stdout: workflowActionFixture({ forbiddenPaths: ["src/secret.ts"] })
        }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("src/secret.ts: blocked path");
    expect(output).toContain("status: BLOCKED");
    expectGuardResultThenExactAction(output);
    expect(process.exitCode).toBe(1);
  });

  it("AC003: an empty Kit writable scope blocks every observed change", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "nope.ts"), "export const nope = 1;\n", "utf8");
    await stage(projectPath, "src/nope.ts");
    await configureKit(
      projectPath,
      healthyKitSpec({
        next: { stdout: workflowActionFixture({ writablePaths: [] }) }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("src/nope.ts: outside allowed files");
    expect(output).toContain("status: BLOCKED");
    expectGuardResultThenExactAction(output);
    expect(process.exitCode).toBe(1);
  });

  it("AC004: configured-unhealthy guard is inconclusive without local fallback", async () => {
    const projectPath = await createRepo();
    await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
    expect(output).not.toContain("scope: Q001");
    expect(process.exitCode).toBe(1);
  });

  it.each(
    (["blocked", "inconclusive"] as const).flatMap((verdict) =>
      (["PASSED", "BLOCKED", "INCONCLUSIVE"] as const).map((operationStatus) => ({
        verdict,
        operationStatus
      }))
    )
  )(
    "AC001: $operationStatus guard result stays separate from $verdict action",
    async ({ verdict, operationStatus }) => {
      const projectPath =
        operationStatus === "INCONCLUSIVE"
          ? await mkdtemp(join(tmpdir(), "visp-guard-nogit-verdict-"))
          : await createRepo();
      if (operationStatus === "PASSED") {
        await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
        await stage(projectPath, "src/ok.ts");
      } else if (operationStatus === "BLOCKED") {
        await mkdir(join(projectPath, "lib"), { recursive: true });
        await writeFile(join(projectPath, "lib", "rogue.ts"), "export const r = 1;\n", "utf8");
        await stage(projectPath, "lib/rogue.ts");
      }
      await configureKit(
        projectPath,
        healthyKitSpec({
          next: {
            stdout: workflowActionFixture({
              verdict,
              findings: [`Kit action is ${verdict}.`],
              nextCommand: "visp scan"
            }),
            exitCode: 1
          }
        })
      );

      await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

      const output = logs.join("\n");
      expect(output).not.toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(output).toContain(`status: ${operationStatus}`);
      const envelope = expectGuardResultThenExactAction(output);
      expect(envelope.action.verdict).toBe(verdict);
      expect(process.exitCode).toBe(1);
    }
  );

  it.each([
    {
      name: "integration acquisition",
      spec: healthyKitSpec({ integration: { stdout: "not-json" } }),
      reasonCode: "integration_contract_unavailable",
      nextCalled: false
    },
    {
      name: "selected schema hash",
      spec: healthyKitSpec({
        integration: {
          stdout: integrationContractFixture("2.0", {
            workflowAction: {
              supported: ["3.0"],
              default: "3.0",
              schemaHashes: { "3.0": `sha256:${"0".repeat(64)}` }
            }
          })
        }
      }),
      reasonCode: "workflow_action_schema_hash_mismatch",
      nextCalled: false
    },
    {
      name: "action acquisition",
      spec: healthyKitSpec({ next: { stdout: "not-json" } }),
      reasonCode: "workflow_action_schema_invalid",
      nextCalled: true
    }
  ])(
    "AC001: $name failure is nonzero without local fallback",
    async ({ spec, reasonCode, nextCalled }) => {
      const projectPath = await createRepo();
      await writeQuickSession(projectPath, { id: "Q001", allowedFiles: ["src"] });
      const shim = await configureKit(projectPath, spec);

      await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

      const output = logs.join("\n");
      expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(output).toContain("status: INCONCLUSIVE");
      expect(output).toContain(`reason_code: ${reasonCode}`);
      expect(output).not.toContain("BEGIN_VISP_GUARD_RESULT");
      expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
      expect(output).not.toContain("scope: Q001");
      expect((await readArgvLog(shim.argvLogPath)).some((argv) => argv[0] === "next")).toBe(
        nextCalled
      );
      expect(process.exitCode).toBe(1);
    }
  );

  it("AC001: unreadable Git renders an inconclusive guard result before ready action", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-guard-nogit-strict-"));
    await configureKit(projectPath);

    await runCli(["node", "visp-hyper", "--project", projectPath, "guard"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: changed_files_unavailable");
    expect(output).toContain(
      "reason: git diff could not be read; scope check was skipped\nstatus: INCONCLUSIVE\nEND_VISP_GUARD_RESULT"
    );
    expect(output).not.toContain("status: PASSED");
    expect(output).not.toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
    expect(expectGuardResultThenExactAction(output).action.verdict).toBe("ready");
    expect(process.exitCode).toBe(1);
  });
});
