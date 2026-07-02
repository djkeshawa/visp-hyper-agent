import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createVispShim, type ShimSpec } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-run-"));
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

async function writeTaskGraph(projectPath: string, options: { provenance?: boolean } = {}): Promise<void> {
  const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
  const includeProvenance = options.provenance ?? true;
  await mkdir(join(featureDir, "context"), { recursive: true });
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const taskGraph = JSON.stringify({
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
        status: "ready"
      },
      {
        id: "T002",
        title: "Second task",
        dependsOn: ["T001"],
        allowedFiles: ["src/other.ts"]
      }
    ]
  });
  await writeFile(join(featureDir, "task-graph.json"), taskGraph, "utf8");
  await writeFile(
    join(featureDir, "context", "T001.context.json"),
    JSON.stringify({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "task target" }],
      ...(includeProvenance
        ? {
            artifactProvenance: [
              {
                label: "task graph",
                path: `.visp/features/${FEATURE_DIR}/task-graph.json`,
                hash: sha256(taskGraph),
                hashAlgorithm: "sha256"
              }
            ]
          }
        : {}),
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

async function readState(projectPath: string): Promise<any> {
  return JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
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

  it("AC004: kit run with allowed gate prints handoff plus task action and sets pipeline", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

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
  });

  it("prints a workflow directive when the graph has parallelizable disjoint tasks", async () => {
    const projectPath = await createProject();
    const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
    await mkdir(join(featureDir, "context"), { recursive: true });
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
            dependsOn: [],
            parallelizable: true,
            allowedFiles: ["src/feature.ts"],
            status: "ready"
          },
          {
            id: "T002",
            title: "Second task",
            dependsOn: [],
            parallelizable: true,
            allowedFiles: ["src/other.ts"]
          },
          { id: "T003", title: "Third task", dependsOn: ["T001", "T002"], allowedFiles: ["src"] }
        ]
      }),
      "utf8"
    );
    await writeFile(
      join(featureDir, "context", "T001.context.json"),
      JSON.stringify({ taskId: "T001", includedFiles: [{ path: "src/feature.ts", reason: "task target" }] }),
      "utf8"
    );

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
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

    const shim = await createVispShim(
      kitStatusSpec({
        integration: {
          stdout: {
            success: true,
            contractVersion: "1.1",
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
        policy: { stdout: { success: true, errors: [] } },
        gate: { stdout: { allowed: true, failedRules: [] } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("warning: Kit integration contract 1.1 does not advertise provenance freshness");
    expect(output).toContain("BEGIN_VISP_TASK_ACTION");
  });

  it("FAIL_CLOSED: checkpoint fails when Kit provenance changes after handoff", async () => {
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
  });

  it("checkpoint carries freshness warnings for context packs without provenance", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath, { provenance: false });

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

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);

    const output = logs.join("\n");
    expect(output).toContain("context_freshness: current");
    expect(output).toContain("warnings:");
    expect(output).toContain("has no artifactProvenance");
    expect(output).toContain("checkpoint can pin only the context-pack file");
    expect(output).toContain("status: PASSED");
  });

  it("AC005: blocked gate prints PIPELINE_BLOCKED and authors no kit artifacts", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        gate: {
          stdout: {
            allowed: false,
            failedRules: [{ ruleId: "R-IMPL-001", message: "Spec not approved" }],
            nextAllowedCommand: "visp specify"
          },
          exitCode: 1
        },
        next: { stdout: { success: true, nextCommand: "visp specify" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("R-IMPL-001");
    expect(output).toContain("next_allowed_command: visp specify");

    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("AC007: next prints the action block after a run, legacy after plain start", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

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

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    let output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).toContain("task: T001");

    // A plain start (kit-less) clears pipeline awareness for the new session.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "plain goal", "--tool", "codex"]);
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "next"]);
    output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_NEXT_ACTION");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).toContain("read .visp/hyper/current/agent-instructions.md");
  });

  it("POLICY_BLOCKED: failing policy validate stops before any handoff or kit artifacts", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const before = await listFeatureFiles(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: {
          stdout: { success: false, errors: ["Policy file references missing rule R-XYZ-001"] }
        },
        // These would let the run proceed; they must never be reached.
        gate: { stdout: { allowed: true, failedRules: [] } },
        next: { stdout: { success: true, nextCommand: "visp implement" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_POLICY_BLOCKED");
    expect(output).toContain("Policy file references missing rule R-XYZ-001");
    // The run returns early: no handoff, no task action, no pipeline-blocked block.
    expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_PIPELINE_BLOCKED");

    // No kit artifacts authored when policy is blocked.
    const after = await listFeatureFiles(projectPath);
    expect(after).toEqual(before);
  });

  it("FAIL_CLOSED: unparseable implement gate output yields PIPELINE_BLOCKED, not an allowed action", async () => {
    const projectPath = await createProject();
    await writeTaskGraph(projectPath);

    const shim = await createVispShim(
      kitStatusSpec({
        policy: { stdout: { success: true, errors: [] } },
        // Non-JSON gate body (a STRING) is unparseable => implementGate is null.
        gate: { stdout: "not json at all — the gate crashed mid-output" },
        next: { stdout: { success: true, nextCommand: "visp tasks" } }
      })
    );
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "run", "implement T001", "--tool", "codex"]);

    const output = logs.join("\n");
    // Fail closed: unknown gate state is treated as blocked, never as permission.
    expect(output).toContain("BEGIN_VISP_PIPELINE_BLOCKED");
    expect(output).toContain("task: T001");
    // An allowed gate would have printed the task action; it must not appear.
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");

    // Pipeline is still initialized (we reached the gate), but the run is blocked.
    const pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T001");
  });

  it("FAIL_CLOSED: checkpoint fails when the adopted Kit context artifact changed after handoff", async () => {
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
  });

  it("AC008: checkpoint --task advances on success and stays/fails on failure", async () => {
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

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    let output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_CHECKPOINT_RESULT");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("next_task: T002");

    let pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T002");
    expect(pipeline.completed).toContain("T001");

    // Now fail T002.
    const failShim = await createVispShim(
      kitStatusSpec({
        verify: { stdout: { success: false } },
        review: { stdout: { success: true } }
      })
    );
    prependToPath(dirname(failShim.binary));

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T002"]);
    output = logs.join("\n");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("verify: FAILED");
    expect(output).toContain("Fix the reported findings");

    pipeline = activePipeline(await readState(projectPath));
    expect(pipeline.currentTaskId).toBe("T002");
    expect(pipeline.stepHistory.some((step: any) => step.action === "checkpoint-failed")).toBe(true);
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
