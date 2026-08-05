import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCommand } from "../src/cli/commands/start.js";
import { runCli } from "../src/cli/index.js";
import { createWorkflowActionV32Id, createWorkflowActionV3Id } from "../src/kit/workflow-action-adapter.js";
import { emptyDelta } from "../src/quality/checkpoint-snapshot.js";
import { toolOnlyPath } from "./helpers/tool-path.js";
import { createVispShim, type ShimSpec } from "./helpers/visp-shim.js";
import {
  healthyStatusFixture,
  integrationContractFixture as sharedIntegrationContractFixture,
  workflowActionV32Fixture
} from "./helpers/canonical-action-fixture.js";

const execFileAsync = promisify(execFile);
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

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp cli workflow "));
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

function workflowActionFixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T900",
    goal: "Resume the authoritative task",
    requiredReads: [],
    writablePaths: ["src/feature.ts"],
    forbiddenPaths: [".env"],
    acceptanceOracles: [],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: "visp verify --task T900",
    ...overrides
  };
}

function workflowActionV3Fixture(overrides: Record<string, unknown> = {}) {
  const draft = {
    protocolVersion: "3.0" as const,
    canonicalVersion: "1.0" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    phase: "implement" as const,
    feature: { id: "001", slug: "strict-resume" },
    task: {
      id: "T900",
      title: "Resume task",
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
    goal: "Resume the authoritative task",
    baseCommit: unavailable("not_captured"),
    requiredReads: [],
    scope: {
      writablePaths: ["src/feature.ts"],
      expectedPaths: unavailable(),
      forbiddenPaths: [".env"],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [],
    validationCommands: ["pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid" as const), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready" as const,
    nextCommand: 'visp verify --task "T900 exact"',
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  };
}

function integrationContractFixture(options: {
  legacy?: boolean;
  protocols?: Record<string, unknown>;
  activeTask?: Record<string, unknown> | null;
} = {}) {
  return {
    success: true,
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo with spaces",
    initialized: true,
    activeFeature: {
      id: "001",
      slug: "strict-resume",
      key: "001-strict-resume",
      path: ".visp/features/001-strict-resume"
    },
    activeTask:
      options.activeTask === undefined
        ? { id: "T900", title: "Resume task", status: "ready" }
        : options.activeTask,
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
      featureDir: ".visp/features/001-strict-resume",
      taskGraph: ".visp/features/001-strict-resume/task-graph.json",
      contextPack: ".visp/features/001-strict-resume/context/T900.context.json",
      contextPrompt: ".visp/features/001-strict-resume/context/T900.prompt.md"
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
    ...(options.legacy
      ? {}
      : {
          protocols:
            options.protocols ?? {
              workflowAction: {
                supported: ["2.0"],
                default: "2.0",
                schemaHashes: { "2.0": V2_HASH }
              }
            }
        })
  };
}

function healthyKitSpec(extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        initialized: true,
        activeFeature: { id: "001", slug: "strict-resume" },
        activeTask: { id: "T900", title: "Resume task", status: "ready" }
      }
    },
    integration: { stdout: integrationContractFixture() },
    next: { stdout: workflowActionFixture() },
    ...extra
  };
}

async function configureKit(projectPath: string, spec: ShimSpec = healthyKitSpec()) {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const shim = await createVispShim(spec);
  process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
  return shim;
}

async function readArgvLog(path: string): Promise<string[][]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

function envelopeFromFrame(output: string): Record<string, any> {
  const lines = output.split("\n");
  const begin = lines.indexOf("BEGIN_VISP_HYPER_ACTION_V1");
  const end = lines.indexOf("END_VISP_HYPER_ACTION_V1");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBe(begin + 2);
  return JSON.parse(lines[begin + 1]!) as Record<string, any>;
}

describe("CLI workflow", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("runs the main local workflow and writes expected files", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "status"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "review"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "Functional workflow covered."]);

    const output = logs.join("\n");
    const handoff = await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8");
    const checkpoint = await readFile(join(projectPath, ".visp", "hyper", "current", "checkpoints.md"), "utf8");
    const review = await readFile(join(projectPath, ".visp", "hyper", "current", "review-report.md"), "utf8");
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    const memoryPath = join(projectPath, ".visp", "memory", "session-history", `${state.activeSessionId}.md`);
    const memory = await readFile(memoryPath, "utf8");

    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain("BEGIN_VISP_NEXT_ACTION");
    expect(output).toContain("BEGIN_VISP_REVIEW_RESULT");
    expect(handoff).toContain("\"toolProfile\": \"codex\"");
    expect(checkpoint).toContain("src/feature.ts");
    expect(review).toContain("No test changes detected for this diff.");
    expect(memory).toContain("Functional workflow covered.");
  });

  it.each(["status", "review"] as const)(
    "configured %s renders the canonical Kit action without local fallback or writes",
    async (command) => {
      const projectPath = await createProject();
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
        logs.push(String(message))
      );
      const shim = await configureKit(projectPath);

      await runCli(["node", "visp-hyper", "--project", projectPath, command]);

      const output = logs.join("\n");
      expect(envelopeFromFrame(output).action).toMatchObject({
        task: { id: "T900" },
        assurance: { level: "kit_strict" },
        verdict: "ready"
      });
      expect(output).not.toContain("Assurance: local_checked");
      expect(output).not.toContain("assurance: local_checked");
      expect(output).not.toContain("BEGIN_VISP_REVIEW_RESULT");
      await expect(
        readFile(join(projectPath, ".visp", "hyper", "current", "review-report.md"), "utf8")
      ).rejects.toThrow();
      expect(await readArgvLog(shim.argvLogPath)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        ["next", "--format", "json", "--protocol", "2.0", "--json"]
      ]);
      expect(process.exitCode).toBeFalsy();
    }
  );

  it.each(["status", "review"] as const)(
    "configured-unhealthy %s stops inconclusively without local fallback",
    async (command) => {
      const projectPath = await createProject();
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
        logs.push(String(message))
      );
      await mkdir(join(projectPath, ".visp"), { recursive: true });
      await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
      process.env.PATH = await toolOnlyPath(["git"]);

      await runCli(["node", "visp-hyper", "--project", projectPath, command]);

      const output = logs.join("\n");
      expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(output).toContain("status: INCONCLUSIVE");
      expect(output).not.toContain("Assurance: local_checked");
      expect(output).not.toContain("assurance: local_checked");
      expect(output).not.toContain("BEGIN_VISP_REVIEW_RESULT");
      expect(process.exitCode).toBe(1);
    }
  );

  it("builds a bounded, non-authoritative challenger request for behavioral work", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await writeFile(
      join(projectPath, "src", "new-behavior.ts"),
      "export const newBehavior = true;\n",
      "utf8"
    );
    let symlinkPath: string | undefined;
    if (process.platform !== "win32") {
      const external = join(await mkdtemp(join(tmpdir(), "visp-challenger-secret-")), "secret.ts");
      await writeFile(external, "DO_NOT_LEAK_EXTERNAL_SECRET\n", "utf8");
      symlinkPath = "src/external-link.ts";
      await symlink(external, join(projectPath, symlinkPath));
    }
    const action = workflowActionV32Fixture({
      assurance: {
        level: "kit_strict",
        profile: available("behavioral"),
        workflowStrictness: available("strict")
      },
      scope: {
        writablePaths: ["src"],
        expectedPaths: unavailable(),
        forbiddenPaths: [".env"],
        operationLimits: unavailable()
      },
      claims: available([
        {
          id: "CLM-001",
          statement: "The feature preserves existing behavior.",
          priority: "must",
          acceptanceCriterionIds: ["AC-001"],
          accountableOwner: unavailable()
        }
      ]),
      requiredEvidence: available([
        {
          version: "1.0",
          id: "EVIDENCE001",
          providerId: "command",
          target: { kind: "command", command: "pnpm test" },
          freshnessRule: "current diff",
          independenceRule: "pre-approved",
          requiredVerdict: "passed"
        },
        {
          version: "1.0",
          id: "EVIDENCE002",
          providerId: "challenger",
          target: { kind: "static_check", checkId: "behavioral-counterexample" },
          freshnessRule: "current diff",
          independenceRule: "independent challenger",
          requiredVerdict: "passed"
        }
      ])
    });
    await configureKit(
      projectPath,
      healthyKitSpec({
        status: { stdout: healthyStatusFixture() },
        integration: {
          stdout: sharedIntegrationContractFixture({ protocols: ["3.2"] })
        },
        next: { stdout: action }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "challenge", "--json"]);

    const request = JSON.parse(logs.join("\n")) as Record<string, any>;
    expect(request).toMatchObject({
      version: "1.0",
      status: "unverified",
      authority: "non_authoritative",
      taskId: "T001",
      actionId: action.actionId,
      assuranceProfile: "behavioral",
      lockedClaims: [{ id: "CLM-001" }],
      evidenceGaps: [{
        id: "EVIDENCE002",
        requiredVerdict: "passed",
        reason: "missing_result",
        observedResults: []
      }],
      hotspots: action.assuranceSummary.state === "available"
        ? action.assuranceSummary.mandatoryHotspots
        : []
    });
    expect(request.evidenceGaps).toHaveLength(1);
    expect(request.repositoryContext.changedFiles).toEqual(
      ["src/feature.ts", ...(symlinkPath ? [symlinkPath] : []), "src/new-behavior.ts"].sort()
    );
    expect(request.repositoryContext.diff).toContain("export const value = 2");
    expect(request.repositoryContext.diff).toContain("export const newBehavior = true");
    expect(request.repositoryContext.diff).not.toContain("DO_NOT_LEAK_EXTERNAL_SECRET");
    expect(request.instructions.join("\n")).toContain("do not execute");
    expect(request).not.toHaveProperty("implementerRationale");
    expect(process.exitCode).toBeFalsy();

    await expect(
      readFile(join(projectPath, ".visp", "hyper", "challenger-human.jsonl"), "utf8")
    ).rejects.toThrow();
    logs.length = 0;
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "challenge",
      "--human-reviewer",
      "reviewer@example.test",
      "--note",
      "Review the behavioral counterexamples.",
      "--json"
    ]);
    const humanRecord = JSON.parse(logs.join("\n")) as Record<string, unknown>;
    expect(humanRecord).toMatchObject({
      version: "1.0",
      status: "pending_human_review",
      authority: "non_authoritative",
      taskId: "T001",
      reviewer: "reviewer@example.test"
    });
    expect(
      JSON.parse(
        (await readFile(
          join(projectPath, ".visp", "hyper", "challenger-human.jsonl"),
          "utf8"
        )).trim()
      )
    ).toMatchObject(humanRecord);

    const sentinel = join(projectPath, "challenger-command-ran");
    const responsePath = join(projectPath, "challenger-response.json");
    await writeFile(
      responsePath,
      JSON.stringify({
        version: "1.0",
        status: "unverified",
        authority: "non_authoritative",
        taskId: "T001",
        actionId: action.actionId,
        proposals: [{
          id: "PROP-001",
          kind: "test_proposal",
          statement: "Try the missing behavioral boundary.",
          relatedClaimIds: ["CLM-001"],
          proposedCommand: `node -e "require('node:fs').writeFileSync('${sentinel}', 'ran')"`
        }]
      }),
      "utf8"
    );
    logs.length = 0;
    process.exitCode = undefined;
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "challenge",
      "--response",
      "challenger-response.json",
      "--json"
    ]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: true,
      response: { status: "unverified", authority: "non_authoritative" }
    });
    await expect(readFile(sentinel, "utf8")).rejects.toThrow();

    await writeFile(
      responsePath,
      JSON.stringify({
        version: "1.0",
        status: "unverified",
        authority: "authoritative",
        taskId: "T001",
        actionId: action.actionId,
        proposals: []
      }),
      "utf8"
    );
    logs.length = 0;
    process.exitCode = undefined;
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "challenge",
      "--response",
      "challenger-response.json",
      "--json"
    ]);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      ok: false,
      status: "unverified",
      authority: "non_authoritative",
      reasonCode: "challenger_response_malformed"
    });
    expect(process.exitCode).toBe(1);
  });

  it("marks the challenger not applicable for routine work and unavailable without Kit", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    const action = workflowActionV3Fixture({
      assurance: {
        level: "kit_strict",
        profile: available("routine"),
        workflowStrictness: available("standard")
      },
      claims: available([])
    });
    await configureKit(
      projectPath,
      healthyKitSpec({
        integration: {
          stdout: integrationContractFixture({
            protocols: {
              workflowAction: {
                supported: ["3.0"],
                default: "3.0",
                schemaHashes: { "3.0": V3_HASH }
              }
            }
          })
        },
        next: { stdout: action }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "challenge"]);
    expect(logs.join("\n")).toContain("status: not_applicable");
    expect(logs.join("\n")).toContain("reason_code: challenger_not_required");
    expect(process.exitCode).toBeFalsy();

    const localProject = await createProject();
    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", localProject, "challenge"]);
    expect(logs.join("\n")).toContain("reason_code: challenger_requires_kit_action");
    expect(process.exitCode).toBe(1);
  });

  it("refuses a human challenger substitution for routine work", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    const action = workflowActionV3Fixture({
      assurance: {
        level: "kit_strict",
        profile: available("routine"),
        workflowStrictness: available("standard")
      },
      claims: available([])
    });
    await configureKit(
      projectPath,
      healthyKitSpec({
        integration: {
          stdout: integrationContractFixture({
            protocols: {
              workflowAction: {
                supported: ["3.0"],
                default: "3.0",
                schemaHashes: { "3.0": V3_HASH }
              }
            }
          })
        },
        next: { stdout: action }
      })
    );

    await runCli([
      "node", "visp-hyper", "--project", projectPath,
      "challenge", "--human-reviewer", "alice"
    ]);

    // A plain `challenge` already reports challenger_not_required here; the
    // substitution path must agree instead of minting an audit record.
    expect(logs.join("\n")).toContain("reason_code: challenger_not_required");
    expect(logs.join("\n")).not.toContain("BEGIN_VISP_HUMAN_CHALLENGER_RECORD");
    await expect(
      readFile(join(projectPath, ".visp", "hyper", "challenger-human.jsonl"), "utf8")
    ).rejects.toThrow();
  });

  it("keeps an evidence requirement in the gaps when no result actually answers it", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    const requirement = {
      version: "1.0",
      id: "EVIDENCE001",
      providerId: "command",
      target: { kind: "command", command: "pnpm test" },
      freshnessRule: "current diff",
      independenceRule: "pre-approved",
      requiredVerdict: "passed"
    };
    const base = workflowActionV32Fixture({
      assurance: {
        level: "kit_strict",
        profile: available("behavioral"),
        workflowStrictness: available("strict")
      },
      claims: available([]),
      requiredEvidence: available([requirement])
    });
    // Kit's own evidence payload, rewritten so the single result still carries
    // requirementId EVIDENCE001 and `passed` but no longer answers the
    // requirement: different provider, different target, and stale.
    const evidence = base.evidence as { state: "available"; value: Record<string, any> };
    const result = evidence.value.providers[0].results[0];
    const action = {
      ...base,
      evidence: available({
        ...evidence.value,
        providers: [{
          ...evidence.value.providers[0],
          provider: { id: "static-analyzer", version: "1.0" },
          results: [{
            ...result,
            requirementId: "EVIDENCE001",
            target: { kind: "static_check", checkId: "unrelated" },
            freshness: { ...result.freshness, status: "stale", reason: "inputs changed" },
            outcome: { status: "passed" }
          }]
        }]
      })
    };
    await configureKit(
      projectPath,
      healthyKitSpec({
        status: { stdout: healthyStatusFixture() },
        integration: {
          stdout: sharedIntegrationContractFixture({ protocols: ["3.2"] })
        },
        next: { stdout: { ...action, actionId: createWorkflowActionV32Id(action) } }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "challenge", "--json"]);

    const request = JSON.parse(logs.join("\n")) as Record<string, any>;
    // Matching on requirementId + `passed` alone would discharge this
    // requirement and drop precisely the gap the challenger exists to surface.
    expect(request.evidenceGaps).toHaveLength(1);
    expect(request.evidenceGaps[0].id).toBe("EVIDENCE001");
    // The near-miss result travels with the gap so the challenger can see why.
    expect(request.evidenceGaps[0].observedResults).toHaveLength(1);
    expect(request.evidenceGaps[0].observedResults[0].freshness.status).toBe("stale");
    expect(request.evidenceGaps[0].observedResults[0].providerId).toBe("static-analyzer");
  });

  // P12: this used to pin `visp-hyper start "<goal>"` as the Kit-less advice.
  // That was a dead end — it creates session files in a project with no engine,
  // and every following command then fails. Worse, this fixture has no
  // visp-kit on PATH at all, so advising `visp-kit init` would be equally
  // wrong. The correct answer is to install the engine first, and this test
  // now pins THAT rather than a fixed string.
  it("sends a Kit-less project to install the engine, not to a dead end", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    process.env.PATH = await toolOnlyPath(["git"]);

    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

    expect(logs.join("\n")).toBe(
      [
        "BEGIN_VISP_NEXT_ACTION",
        "session_id: none",
        "next: run `visp setup`",
        "END_VISP_NEXT_ACTION"
      ].join("\n")
    );
    expect(process.exitCode).toBeFalsy();

    logs.length = 0;
    process.exitCode = undefined;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    expect(logs.join("\n")).toBe(
      [
        "BEGIN_VISP_RESUME",
        "session_id: none",
        'next: visp work "<goal>"',
        "END_VISP_RESUME"
      ].join("\n")
    );
    expect(process.exitCode).toBe(1);

    logs.length = 0;
    process.exitCode = undefined;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    expect(logs.join("\n")).toBe(
      JSON.stringify(
        {
          success: false,
          projectPath,
          sessionId: null,
          requiredReads: [],
          artifacts: [],
          latestCheckpoint: null,
          changedFiles: [],
          checkpointDelta: emptyDelta(),
          warnings: ["No active Visp Hyper session."],
          nextCommand: 'visp work "<goal>"'
        },
        null,
        2
      )
    );
    expect(process.exitCode).toBe(1);
  });

  it("resumes an active session with handoff and current diff context", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 3;\n", "utf8");
    await writeFile(join(projectPath, "src", "new-file.ts"), "export const created = true;\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_RESUME");
    expect(output).toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).toContain(".visp/hyper/current/context-pack.md: present");
    expect(output).toContain("latest_checkpoint:");
    expect(output).toContain("context_freshness: untracked");
    expect(output).toContain("checkpoint_delta:");
    expect(output).toContain("unchanged_since_checkpoint:");
    expect(output).toContain("src/feature.ts");
    expect(output).toContain("src/new-file.ts");
    expect(output).toContain("next: visp-hyper next");
  });

  it("resume JSON reports stale context freshness and points back to run", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);
    const contextPackPath = join(projectPath, ".visp", "hyper", "current", "context-pack.md");
    const originalContext = await readFile(contextPackPath, "utf8");
    await writeFile(
      join(projectPath, ".visp", "hyper", "current", "context-manifest.json"),
      JSON.stringify({
        version: "0.1",
        sessionId: "vh_test",
        contextArtifact: {
          path: ".visp/hyper/current/context-pack.md",
          hash: sha256(originalContext),
          hashAlgorithm: "sha256"
        }
      }),
      "utf8"
    );
    await writeFile(contextPackPath, `${originalContext}\nchanged after handoff\n`, "utf8");

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    const summary = JSON.parse(logs.join("\n"));
    expect(summary.contextFreshness).toMatchObject({
      status: "stale",
      blocking: true
    });
    expect(summary.contextFreshness.finding).toContain("context artifact changed since handoff");
    expect(summary.warnings.join("\n")).toContain("context artifact changed since handoff");
    expect(summary.nextCommand).toContain('visp work "implement feature"');
  });

  it("reports exact file deltas since the latest checkpoint", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 4;\n", "utf8");
    await writeFile(join(projectPath, "src", "new-file.ts"), "export const created = true;\n", "utf8");
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 5;\n", "utf8");
    await writeFile(join(projectPath, "src", "after-checkpoint.ts"), "export const later = true;\n", "utf8");
    await rm(join(projectPath, "src", "new-file.ts"));

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    const summary = JSON.parse(logs.join("\n"));
    expect(summary.checkpointDelta.addedSinceCheckpoint).toContain("src/after-checkpoint.ts");
    expect(summary.checkpointDelta.changedSinceCheckpoint).toContain("src/feature.ts");
    expect(summary.checkpointDelta.clearedSinceCheckpoint).toContain("src/new-file.ts");
    expect(summary.checkpointDelta.unchangedSinceCheckpoint).not.toContain("src/feature.ts");
  });

  it("AC002: configured resume renders the negotiated action without stale local data", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "local stale goal"]);
    const stateBefore = await readFile(
      join(projectPath, ".visp", "hyper", "state.json"),
      "utf8"
    );
    const action = workflowActionFixture();
    await configureKit(projectPath, healthyKitSpec({ next: { stdout: action } }));

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    const envelope = envelopeFromFrame(output);
    expect(output).toBe(
      [
        "BEGIN_VISP_RESUME",
        "authority: kit",
        "task: T900",
        "verdict: ready",
        "next: visp verify --task T900",
        "END_VISP_RESUME",
        "",
        "BEGIN_VISP_HYPER_ACTION_V1",
        JSON.stringify(envelope),
        "END_VISP_HYPER_ACTION_V1"
      ].join("\n")
    );
    expect(output).toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(output).toContain("verdict: ready");
    expect(output).toContain("next: visp verify --task T900");
    expect(envelope).toMatchObject({
      frameVersion: "1.0",
      authority: "kit",
      action: {
        normalizationVersion: "1.0",
        source: { protocolVersion: "2.0" },
        task: { id: "T900" },
        verdict: "ready",
        nextCommand: "visp verify --task T900"
      }
    });
    expect(envelope.action).not.toHaveProperty("wire");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).not.toContain("local stale goal");
    expect(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    ).toBe(stateBefore);
    expect(process.exitCode).toBeFalsy();
  });

  it("AC002: configured resume JSON is the standalone public envelope", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    const action = workflowActionFixture();
    await configureKit(projectPath, healthyKitSpec({ next: { stdout: action } }));

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    const output = logs.join("\n");
    const envelope = JSON.parse(output);
    expect(output).toBe(JSON.stringify(envelope, null, 2));
    expect(envelope).toMatchObject({
      frameVersion: "1.0",
      authority: "kit",
      action: {
        source: { protocolVersion: "2.0" },
        verdict: "ready",
        nextCommand: action.nextCommand
      }
    });
    expect(envelope.action).not.toHaveProperty("wire");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC002: configured resume auto-selects v3 and preserves its exact opaque next command", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    const action = workflowActionV3Fixture();
    const shim = await configureKit(
      projectPath,
      healthyKitSpec({
        integration: {
          stdout: integrationContractFixture({
            protocols: {
              workflowAction: {
                supported: ["2.0", "3.0"],
                default: "2.0",
                schemaHashes: { "2.0": V2_HASH, "3.0": V3_HASH }
              }
            }
          })
        },
        next: { stdout: action }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    const envelope = JSON.parse(logs.join("\n"));
    expect(envelope).toMatchObject({
      frameVersion: "1.0",
      authority: "kit",
      action: {
        source: { protocolVersion: "3.0" },
        task: { id: "T900" },
        verdict: "ready",
        nextCommand: 'visp verify --task "T900 exact"'
      }
    });
    expect(await readArgvLog(shim.argvLogPath)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--protocol", "3.0", "--json"]
    ]);
  });

  it("AC002: selector-less legacy v2 stays visibly legacy and omits --protocol", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
      logs.push(String(message))
    );
    const shim = await configureKit(
      projectPath,
      healthyKitSpec({
        integration: { stdout: integrationContractFixture({ legacy: true }) }
      })
    );

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    expect(JSON.parse(logs.join("\n")).action.source).toMatchObject({
      protocolVersion: "2.0",
      selectionMode: "legacy_v2",
      schemaHashVerification: { state: "legacy_unadvertised" }
    });
    expect(await readArgvLog(shim.argvLogPath)).toEqual([
      ["status", "--json"],
      ["integration", "contract", "--json"],
      ["next", "--format", "json", "--json"]
    ]);
  });

  it.each([
    {
      name: "advertised v2",
      legacy: false,
      selectionMode: "advertised",
      hashState: "advertised_verified",
      nextArgv: ["next", "--format", "json", "--protocol", "2.0", "--json"]
    },
    {
      name: "selector-less legacy v2",
      legacy: true,
      selectionMode: "legacy_v2",
      hashState: "legacy_unadvertised",
      nextArgv: ["next", "--format", "json", "--json"]
    }
  ])(
    "AC002: configured next preserves $name negotiation provenance and argv",
    async ({ legacy, selectionMode, hashState, nextArgv }) => {
      const projectPath = await createProject();
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
        logs.push(String(message))
      );
      const shim = await configureKit(
        projectPath,
        healthyKitSpec({
          integration: { stdout: integrationContractFixture(legacy ? { legacy: true } : {}) }
        })
      );

      await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);

      expect(envelopeFromFrame(logs.join("\n")).action.source).toMatchObject({
        protocolVersion: "2.0",
        selectionMode,
        schemaHashVerification: { state: hashState }
      });
      expect(await readArgvLog(shim.argvLogPath)).toEqual([
        ["status", "--json"],
        ["integration", "contract", "--json"],
        nextArgv
      ]);
      expect(process.exitCode).toBeFalsy();
    }
  );

  it("AC006: configured-unhealthy resume does not fall back to a local session", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "local stale goal"]);
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    process.env.PATH = await toolOnlyPath(["git"]);

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).not.toContain("BEGIN_VISP_RESUME");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(process.exitCode).toBe(1);
  });

  it("AC002: malformed configured action stops inconclusively without local output", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await configureKit(projectPath, healthyKitSpec({ next: { stdout: "not-json" } }));

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: workflow_action_schema_invalid");
    expect(output).not.toContain("BEGIN_VISP_RESUME");
    expect(output).not.toContain("BEGIN_VISP_HYPER_ACTION_V1");
    expect(process.exitCode).toBe(1);
  });

  it.each(["blocked", "inconclusive"] as const)(
    "AC002: coherent %s action remains authoritative and exits nonzero",
    async (verdict) => {
      const projectPath = await createProject();
      const logs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message?: unknown) =>
        logs.push(String(message))
      );
      await configureKit(
        projectPath,
        healthyKitSpec({
          integration: {
            stdout: integrationContractFixture({ activeTask: null })
          },
          next: {
            stdout: workflowActionFixture({
              taskId: null,
              writablePaths: [],
              verdict,
              findings: [`Kit action is ${verdict}`],
              nextCommand: "visp scan"
            }),
            exitCode: 1
          }
        })
      );

      await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

      const output = logs.join("\n");
      const envelope = envelopeFromFrame(output);
      expect(output).toContain("BEGIN_VISP_RESUME");
      expect(output).toContain(`verdict: ${verdict}`);
      expect(output).toContain("task: none");
      expect(output).toContain("next: visp scan");
      expect(output).not.toContain("BEGIN_VISP_KIT_AUTHORITY_RESULT");
      expect(envelope.action).toMatchObject({
        task: null,
        verdict,
        nextCommand: "visp scan"
      });
      expect(process.exitCode).toBe(1);
    }
  );

  it("rejects unsupported tool values", async () => {
    const command = startCommand();
    command.exitOverride();
    command.configureOutput({ writeErr: () => {} });

    await expect(command.parseAsync(["node", "start", "goal", "--tool", "unsupported"])).rejects.toThrow(/is invalid/);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
