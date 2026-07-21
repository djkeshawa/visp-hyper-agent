import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeStart, startCommand } from "../src/cli/commands/start.js";
import { runCli } from "../src/cli/index.js";
import { toolOnlyPath } from "./helpers/tool-path.js";
import { createVispShim, type ShimSpec } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-cli-workflow-"));
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

function healthyKitSpec(projectPath: string, extra: ShimSpec = {}): ShimSpec {
  return {
    status: {
      stdout: {
        success: true,
        targetPath: projectPath,
        initialized: true,
        activeFeature: { id: "001", slug: "strict-resume" },
        activeTask: { id: "T900", title: "Resume task", status: "ready" }
      }
    },
    next: { stdout: workflowActionFixture() },
    ...extra
  };
}

async function configureKit(projectPath: string, spec: ShimSpec = healthyKitSpec(projectPath)): Promise<void> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  const shim = await createVispShim(spec);
  process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;
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

  it("publishes current artifacts for the active concurrent session", async () => {
    const projectPath = await createProject();
    const starts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        executeStart(projectPath, `concurrent start ${index}`, {
          tool: "codex",
          authority: { mode: "local" }
        })
      )
    );

    const state = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")
    );
    const handoff = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8")
    );
    const sessionMarkdown = await readFile(
      join(projectPath, ".visp", "hyper", "current", "session.md"),
      "utf8"
    );

    expect(Object.keys(state.sessions)).toHaveLength(starts.length);
    expect(handoff.session.id).toBe(state.activeSessionId);
    expect(sessionMarkdown).toContain(`Session ${state.activeSessionId}`);
    expect(sessionMarkdown).toContain(state.sessions[state.activeSessionId].goal);
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
    expect(summary.nextCommand).toContain('visp-hyper run "implement feature"');
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

  it("AC005: configured resume returns the ready Kit action and exact next command", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "local stale goal"]);
    const action = workflowActionFixture();
    await configureKit(projectPath, healthyKitSpec(projectPath, { next: { stdout: action } }));

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    expect(output).toContain("BEGIN_VISP_WORKFLOW_ACTION_V2");
    expect(output).toContain(JSON.stringify(action));
    expect(output).toContain("next: visp verify --task T900");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");
    expect(output).not.toContain("BEGIN_VISP_AGENT_HANDOFF");
    expect(process.exitCode).toBeFalsy();
  });

  it("AC005: configured resume JSON is the canonical ready action", async () => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    const action = workflowActionFixture();
    await configureKit(projectPath, healthyKitSpec(projectPath, { next: { stdout: action } }));

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume", "--json"]);

    expect(JSON.parse(logs.join("\n"))).toEqual(action);
    expect(process.exitCode).toBeFalsy();
  });

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

  it.each([
    {
      name: "malformed",
      next: { stdout: "not-json" },
      reasonCode: "strict_next_unavailable"
    },
    {
      name: "non-ready",
      next: {
        stdout: workflowActionFixture({
          taskId: null,
          writablePaths: [],
          verdict: "blocked",
          findings: ["VSP001: scan required"],
          nextCommand: "visp scan"
        }),
        exitCode: 1
      },
      reasonCode: "workflow_action_blocked"
    }
  ])("AC006: $name Kit action is inconclusive without local output", async ({ next, reasonCode }) => {
    const projectPath = await createProject();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => logs.push(String(message)));
    await configureKit(projectPath, healthyKitSpec(projectPath, { next }));

    await runCli(["node", "visp-hyper", "--project", projectPath, "resume"]);

    const output = logs.join("\n");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain(`reason_code: ${reasonCode}`);
    expect(output).not.toContain("BEGIN_VISP_RESUME");
    expect(output).not.toContain("BEGIN_VISP_WORKFLOW_ACTION_V2");
    expect(process.exitCode).toBe(1);
  });

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
