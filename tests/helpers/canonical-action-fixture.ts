import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createWorkflowActionV31Id,
  createWorkflowActionV32Id,
  createWorkflowActionV34Id,
  createWorkflowActionV3Id
} from "../../src/kit/workflow-action-adapter.js";
import type {
  WorkflowActionV31Wire,
  WorkflowActionV32Wire,
  WorkflowActionV34Wire,
  WorkflowActionV3Wire
} from "../../src/kit/workflow-action-protocol.js";
import {
  authoritativeContextPackFixture,
  authoritativeTaskFixture,
  authoritativeTaskGraphFixture,
  gateResultFixture,
  policyValidateFixture,
  type ShimSpec
} from "./visp-shim.js";

const execFileAsync = promisify(execFile);

export const CANONICAL_ACTION_RESOURCE_URI = "visp-hyper://current/canonical-action";
export const WORKTREE_BRANCH = "feature/p1-07c1-conformance";
export const V2_SCHEMA_HASH =
  "sha256:c63b279b1ce89f047b2be696a47e845a57adda7f8437892e211e3a4cfad39ed6";
export const V3_SCHEMA_HASH =
  "sha256:ceb45ad3a27a4172c4dbe7e7caacf473570f4578eda27744662a8ed094e96ce7";
export const V31_SCHEMA_HASH =
  "sha256:41ffa28fcd4476ea1812ff307df67a7ab7edb5b2cf4d6c11955d34d4aad74d4d";
export const V32_SCHEMA_HASH =
  "sha256:77dcaba51ef8e1a78064680077f8bcc48c081d8025596c6cc8df9ea7873d68e9";
export const V34_SCHEMA_HASH =
  "sha256:bee85bf783a3557c99c9feb716e967997595dfa228380be71815da531f055ca5";

const FEATURE_DIR = "001-pipeline";
const unavailable = (reasonCode = "not_in_source_artifact") => ({
  state: "unavailable" as const,
  reasonCode
});
const available = <T>(value: T) => ({ state: "available" as const, value });
const notApplicable = (
  reasonCode: "no_active_task" | "stage_does_not_require_value"
) => ({ state: "not_applicable" as const, reasonCode });

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function workflowActionV2Fixture(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2.0",
    phase: "implement",
    taskId: "T001",
    goal: "Implement the canonical action resource",
    requiredReads: [],
    writablePaths: ["src/feature.ts", "src/path with spaces.ts"],
    forbiddenPaths: ["secrets"],
    acceptanceOracles: [],
    validationCommands: ["pnpm test"],
    assuranceLevel: "kit_strict",
    verdict: "ready",
    findings: [],
    nextCommand: 'visp gate implement --task "T001 exact"',
    ...overrides
  };
}

export function workflowActionV3Fixture(
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
    goal: "Implement the canonical action resource",
    baseCommit: unavailable("not_captured"),
    requiredReads: [],
    scope: {
      writablePaths: ["src/feature.ts", "src/path with spaces.ts"],
      expectedPaths: unavailable(),
      forbiddenPaths: ["secrets"],
      operationLimits: unavailable()
    },
    claims: unavailable(),
    validationOracles: [],
    validationCommands: ["pnpm typecheck", "pnpm test"],
    requiredEvidence: unavailable(),
    policy: { status: available("valid" as const), appliedOverrides: available([]) },
    findings: [],
    verdict: "ready" as const,
    nextCommand: 'visp gate implement --task "T001 exact" && printf opaque',
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV3Id(draft)
  } as WorkflowActionV3Wire;
}

export function tasklessWorkflowActionV3Fixture(
  verdict: "ready" | "blocked" | "inconclusive" = "ready"
): WorkflowActionV3Wire {
  return workflowActionV3Fixture({
    phase: "pr",
    task: null,
    taskClass: notApplicable("no_active_task"),
    risk: {
      level: notApplicable("no_active_task"),
      factors: notApplicable("no_active_task")
    },
    goal: "Prepare the pull request",
    scope: {
      writablePaths: [],
      expectedPaths: notApplicable("stage_does_not_require_value"),
      forbiddenPaths: [],
      operationLimits: notApplicable("stage_does_not_require_value")
    },
    claims: notApplicable("stage_does_not_require_value"),
    validationOracles: [],
    validationCommands: [],
    requiredEvidence: notApplicable("stage_does_not_require_value"),
    findings: verdict === "ready" ? [] : [{
      code: `VISP.TEST.${verdict.toUpperCase()}`,
      source: "workflow",
      severity: verdict === "blocked" ? "error" : "warning",
      effect: verdict === "blocked" ? "blocks" : "uncertain",
      message: `Taskless ${verdict} fixture.`,
      recommendation: "Follow the exact Kit command.",
      evidence: []
    }],
    verdict,
    nextCommand: "visp pr"
  });
}

export function workflowActionV31Fixture(
  overrides: Record<string, unknown> = {}
): WorkflowActionV31Wire {
  const {
    protocolVersion: _protocolVersion,
    canonicalVersion: _canonicalVersion,
    actionId: _actionId,
    ...v3Body
  } = workflowActionV3Fixture();
  const draft = {
    ...v3Body,
    protocolVersion: "3.1" as const,
    canonicalVersion: "1.1" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    evidence: available({
      version: "1.0" as const,
      source: "candidate" as const,
      artifact: {
        path: ".visp/features/001-pipeline/evidence/T001.candidate.json",
        contentHash: `sha256:${"b".repeat(64)}`
      },
      generatedAt: "2026-07-25T00:00:00.000Z",
      outcome: "passed" as const,
      freshness: "fresh" as const,
      providers: [
        {
          id: "PROVIDER001",
          provider: { id: "command", version: "1.0" },
          status: "passed" as const,
          failure: null,
          results: [
            {
              id: "RESULT001",
              requirementId: "EVIDENCE001",
              target: { kind: "command" as const, command: "pnpm test" },
              freshness: {
                status: "fresh" as const,
                checkedAt: "2026-07-25T00:00:00.000Z",
                inputHashes: [
                  { id: "workspace", sha256: `sha256:${"c".repeat(64)}` }
                ]
              },
              independence: "pre_approved" as const,
              outcome: { status: "passed" as const }
            }
          ]
        }
      ],
      testStrength: available({
        status: "passed" as const,
        independence: ["pre_approved" as const],
        reason: "A pre-approved test passed."
      })
    }),
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV31Id(draft)
  } as WorkflowActionV31Wire;
}

export function workflowActionV32Fixture(
  overrides: Record<string, unknown> = {}
): WorkflowActionV32Wire {
  const {
    protocolVersion: _protocolVersion,
    canonicalVersion: _canonicalVersion,
    actionId: _actionId,
    ...v31Body
  } = workflowActionV31Fixture();
  const draft = {
    ...v31Body,
    protocolVersion: "3.2" as const,
    canonicalVersion: "1.2" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    assuranceSummary: {
      state: "available" as const,
      version: "1.0" as const,
      artifact: {
        path: ".visp/features/001-pipeline/assurance/T001/assurance-case.json",
        contentHash: `sha256:${"d".repeat(64)}`
      },
      caseHash: `sha256:${"e".repeat(64)}`,
      verdict: "inconclusive" as const,
      mandatoryHotspots: [
        {
          id: "HS001",
          category: "security" as const,
          severity: "critical" as const,
          path: "src/feature.ts",
          reason: "Security-sensitive behavior requires accountable review."
        }
      ],
      reviewDecision: {
        required: true,
        status: "missing" as const,
        decisionHash: null,
        reason: "No review decision is recorded."
      }
    },
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV32Id(draft)
  } as WorkflowActionV32Wire;
}

export function workflowActionV34Fixture(
  overrides: Record<string, unknown> = {}
): WorkflowActionV34Wire {
  const {
    protocolVersion: _protocolVersion,
    canonicalVersion: _canonicalVersion,
    actionId: _actionId,
    ...v32Body
  } = workflowActionV32Fixture();
  const draft = {
    ...v32Body,
    protocolVersion: "3.4" as const,
    canonicalVersion: "1.3" as const,
    actionId: `sha256:${"0".repeat(64)}`,
    ...overrides
  };
  return {
    ...draft,
    actionId: createWorkflowActionV34Id(draft)
  } as WorkflowActionV34Wire;
}

export function integrationContractFixture(options: {
  protocols?: readonly ("2.0" | "3.0" | "3.1" | "3.2")[] | null;
  activeTask?: Record<string, unknown> | null;
  overrides?: Record<string, unknown>;
} = {}) {
  const protocols = options.protocols === undefined ? ["2.0", "3.0"] : options.protocols;
  return {
    success: true,
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: "/repo with spaces",
    initialized: true,
    activeFeature: {
      id: "001",
      slug: "pipeline",
      key: FEATURE_DIR,
      path: `.visp/features/${FEATURE_DIR}`
    },
    activeTask: options.activeTask === undefined
      ? { id: "T001", title: "First task", status: "ready" }
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
      featureDir: `.visp/features/${FEATURE_DIR}`,
      taskGraph: `.visp/features/${FEATURE_DIR}/task-graph.json`,
      contextPack: `.visp/features/${FEATURE_DIR}/context/T001.context.json`,
      contextPrompt: `.visp/features/${FEATURE_DIR}/context/T001.prompt.md`
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
    warnings: [],
    ...(protocols === null
      ? {}
      : {
          protocols: {
            workflowAction: {
              supported: protocols,
              default: protocols[0],
              schemaHashes: Object.fromEntries(
                protocols.map((protocol) => [
                  protocol,
                  protocol === "3.2"
                    ? V32_SCHEMA_HASH
                    : protocol === "3.1"
                    ? V31_SCHEMA_HASH
                    : protocol === "3.0"
                      ? V3_SCHEMA_HASH
                      : V2_SCHEMA_HASH
                ])
              )
            }
          }
        }),
    ...options.overrides
  };
}

export function healthyStatusFixture(activeTask: Record<string, unknown> | null = {
  id: "T001",
  title: "First task",
  status: "ready"
}) {
  return {
    success: true,
    initialized: true,
    activeFeature: { id: "001", slug: "pipeline" },
    activeTask
  };
}

export function canonicalKitSpec(options: {
  action?: object | string;
  actionExitCode?: number;
  contract?: object | string;
  status?: object | string;
  extra?: ShimSpec;
} = {}): ShimSpec {
  const action = options.action ?? workflowActionV3Fixture();
  return {
    status: { stdout: options.status ?? healthyStatusFixture() },
    integration: { stdout: options.contract ?? integrationContractFixture() },
    next: { stdout: action, ...(options.actionExitCode === undefined ? {} : { exitCode: options.actionExitCode }) },
    policy: { stdout: policyValidateFixture() },
    "gate next": { stdout: gateResultFixture({ stage: "next" }) },
    "gate implement": { stdout: gateResultFixture({ stage: "implement" }) },
    verify: { stdout: { success: true } },
    review: { stdout: { success: true } },
    reconcile: { stdout: { success: true } },
    ...options.extra
  };
}

export async function createCanonicalProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-canonical-project-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Canonical fixture\n", "utf8");
  await writeFile(join(projectPath, "package.json"), '{"name":"canonical-fixture"}\n', "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  await writeStrictProjectArtifacts(projectPath);
  return projectPath;
}

export async function createLinkedCanonicalWorktree(): Promise<string> {
  const source = await createCanonicalProject();
  const root = await mkdtemp(join(tmpdir(), "visp canonical worktree "));
  const worktree = join(root, "linked project with spaces");
  await execFileAsync("git", ["worktree", "add", "-b", WORKTREE_BRANCH, worktree], { cwd: source });
  await writeStrictProjectArtifacts(worktree);
  return worktree;
}

export async function writeStrictProjectArtifacts(projectPath: string): Promise<void> {
  const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
  const contextDir = join(featureDir, "context");
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const task = authoritativeTaskFixture({
    allowedFiles: ["src/feature.ts", "src/path with spaces.ts"]
  });
  const taskGraph = JSON.stringify(authoritativeTaskGraphFixture({ tasks: [task] }));
  await writeFile(join(featureDir, "task-graph.json"), taskGraph, "utf8");
  await writeFile(
    join(contextDir, "T001.context.json"),
    JSON.stringify(authoritativeContextPackFixture({
      selectedTask: task,
      artifactProvenance: [{
        label: "task graph",
        path: `.visp/features/${FEATURE_DIR}/task-graph.json`,
        hash: sha256(taskGraph),
        hashAlgorithm: "sha256"
      }]
    })),
    "utf8"
  );
}

export async function projectBoundV3Action(
  projectPath: string,
  overrides: Record<string, unknown> = {}
): Promise<WorkflowActionV3Wire> {
  const taskGraphPath = `.visp/features/${FEATURE_DIR}/task-graph.json`;
  const contextPath = `.visp/features/${FEATURE_DIR}/context/T001.context.json`;
  const [taskGraph, context] = await Promise.all([
    readFile(join(projectPath, taskGraphPath), "utf8"),
    readFile(join(projectPath, contextPath), "utf8")
  ]);
  return workflowActionV3Fixture({
    requiredReads: [
      {
        id: "task-graph",
        role: "task_graph",
        path: taskGraphPath,
        contentHash: `sha256:${sha256(taskGraph)}`,
        freshness: "content_hash"
      },
      {
        id: "task-context",
        role: "context_pack",
        path: contextPath,
        contentHash: `sha256:${sha256(context)}`,
        freshness: "content_hash"
      }
    ],
    ...overrides
  });
}

export function parseActionFrame(output: string): Record<string, unknown> {
  const lines = output.split("\n");
  const begins = lines
    .map((line, index) => line === "BEGIN_VISP_HYPER_ACTION_V1" ? index : -1)
    .filter((index) => index >= 0);
  const ends = lines
    .map((line, index) => line === "END_VISP_HYPER_ACTION_V1" ? index : -1)
    .filter((index) => index >= 0);
  const begin = begins[0];
  const end = ends[0];
  if (begins.length !== 1 || ends.length !== 1 || begin === undefined || end !== begin + 2) {
    throw new Error("Expected exactly one compact VISP_HYPER_ACTION_V1 frame.");
  }
  return JSON.parse(lines[begin + 1]!) as Record<string, unknown>;
}

export async function snapshotProject(projectPath: string): Promise<Array<{ path: string; bytes: string }>> {
  const snapshot: Array<{ path: string; bytes: string }> = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, relative);
      } else {
        snapshot.push({ path: relative, bytes: (await readFile(absolute)).toString("base64") });
      }
    }
  }
  await walk(projectPath, "");
  return snapshot;
}
