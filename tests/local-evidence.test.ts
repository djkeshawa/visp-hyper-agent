import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { collectLocalEvidence } from "../src/quality/local-evidence.js";
import { createVispShim } from "./helpers/visp-shim.js";
import { toolOnlyPath } from "./helpers/tool-path.js";

// Resolve every helper's git call the same way the product does, so bare
// commands still spawn when the test replaces PATH with an isolated tool dir.
const execFileAsync = execFileResolved;

const originalPath = process.env.PATH;

const FEATURE_DIR = "001-pipeline";

async function gitInit(projectPath: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileAsync("git", ["add", "."], { cwd: projectPath });
  await execFileAsync(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
}

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-local-"));
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
 * A PATH directory that exposes git and node (needed by validation commands and
 * the checkpoint's git diff) but deliberately omits any installed `visp` binary
 * so the kit-less branch is exercised.
 */
async function gitNodeOnlyPath(): Promise<string> {
  return toolOnlyPath(["git"]);
}

describe("collectLocalEvidence", () => {
  it("AC001-verify: passing validation command yields verifyPassed", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node --version"] },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(true);
  });

  it("AC001-verify: failing validation command yields a finding", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node -e process.exit(2)"] },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(false);
    expect(evidence.findings.some((line) => line.startsWith("verify failed: node -e process.exit(2) (exit 2)"))).toBe(
      true
    );
  });

  it("AC001-verify: an unspawnable validation command fails closed but reports 'could not be run'", async () => {
    const projectPath = await createRepo();
    const command = "definitely-not-a-real-binary-xyz --version";
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: [command] },
      blockedPaths: []
    });
    // Fail closed: a command that never ran must not count as a pass.
    expect(evidence.verifyPassed).toBe(false);
    // ...but it is reported distinctly from a genuine "verify failed".
    expect(evidence.findings.some((line) => line.includes("could not be run"))).toBe(true);
    expect(evidence.findings.some((line) => line.startsWith("verify failed:"))).toBe(false);
    expect(evidence.warnings.some((line) => line.includes("could not be run"))).toBe(true);
  });

  it("reports inconclusive when no validation commands exist", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: []
    });
    expect(evidence.verifyPassed).toBe(false);
    expect(evidence.verifyVerdict).toBe("inconclusive");
    expect(evidence.warnings).toContain("no validation commands detected; verification is inconclusive");
  });

  it("AC003-scope: changed file outside allowed files fails review", async () => {
    const projectPath = await createRepo();
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "other.ts"), "export const x = 2;\n", "utf8");
    await stage(projectPath, "lib/other.ts");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings).toContain("scope violation: lib/other.ts outside allowed files");
  });

  it("AC003-scope: untracked file outside allowed files fails review", async () => {
    const projectPath = await createRepo();
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "untracked.ts"), "export const x = 2;\n", "utf8");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings).toContain("scope violation: lib/untracked.ts outside allowed files");
  });

  it("AC003-scope: changed file inside allowed files passes review", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(true);
    expect(evidence.findings.some((line) => line.startsWith("scope violation:"))).toBe(false);
  });

  it("AC003-scope: visp-hyper's own .visp/ output is not a scope violation", async () => {
    const projectPath = await createRepo();
    // An in-scope user change plus visp-hyper's own generated tree.
    await writeFile(join(projectPath, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await stage(projectPath, "src/ok.ts");
    await mkdir(join(projectPath, ".visp", "hyper", "current"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "hyper", "state.json"), "{}\n", "utf8");
    await writeFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "{}\n", "utf8");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"] },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(true);
    expect(evidence.findings.some((line) => line.includes(".visp"))).toBe(false);
  });

  it("AC003-scope: canonical Visp policy changes remain protected", async () => {
    const projectPath = await createRepo();
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
    await execFileAsync("git", ["add", ".visp/policy.json"], { cwd: projectPath });
    await execFileAsync("git", ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "add policy"], { cwd: projectPath });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{\"changed\":true}\n", "utf8");
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src/ok.ts"], validationCommands: ["node --version"] },
      blockedPaths: []
    });
    expect(evidence.reviewVerdict).toBe("failed");
    expect(evidence.findings).toContain("scope violation: .visp/policy.json outside allowed files");
  });

  it("AC003-scope: blocked path change fails review", async () => {
    const projectPath = await createRepo();
    await writeFile(join(projectPath, ".env"), "SECRET=1\n", "utf8");
    await stage(projectPath, ".env");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: [".env"]
    });
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings).toContain("scope violation: .env is a blocked path");
  });

  it("empty diff: review passes with a no-changes finding", async () => {
    const projectPath = await createRepo();
    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001" },
      blockedPaths: []
    });
    expect(evidence.reviewPassed).toBe(true);
    expect(evidence.findings).toContain("no changes detected");
  });
});

describe("checkpoint --task local evidence integration", () => {
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

  async function writeTaskGraph(projectPath: string, validationCommands: string[]): Promise<void> {
    const featureDir = join(projectPath, ".visp", "features", FEATURE_DIR);
    await mkdir(featureDir, { recursive: true });
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
            description: "Implement the first task",
            dependsOn: [],
            allowedFiles: ["src/feature.ts"],
            validationCommands,
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
  }

  async function injectPipeline(projectPath: string, validationCommands?: string[]): Promise<void> {
    const statePath = join(projectPath, ".visp", "hyper", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const sessionId = state.activeSessionId;
    state.sessions[sessionId].pipeline = {
      taskIds: ["T001", "T002"],
      currentTaskId: "T001",
      completed: [],
      stepHistory: [],
      ...(validationCommands
        ? {
            syntheticTasks: [
              {
                id: "T001",
                title: "First task",
                description: "Implement the first task",
                dependsOn: [],
                allowedFiles: ["src/feature.ts"],
                validationCommands,
                status: "ready"
              },
              {
                id: "T002",
                title: "Second task",
                description: "Implement the second task",
                dependsOn: ["T001"],
                allowedFiles: ["src/other.ts"],
                status: "pending"
              }
            ]
          }
        : {})
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  async function readPipeline(projectPath: string): Promise<any> {
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    return state.sessions[state.activeSessionId].pipeline;
  }

  it("AC001/AC002: passing local evidence advances the pipeline", async () => {
    const projectPath = await createRepo();

    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    // A real, in-scope change so review has something to inspect.
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: local");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("next_task: T002");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T002");
    expect(pipeline.completed).toContain("T001");
  });

  it("AC001/AC002: failing validation keeps the current task and reports findings", async () => {
    const projectPath = await createRepo();

    process.env.PATH = await gitNodeOnlyPath();

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node -e process.exit(2)"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: local");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("verify: FAILED");
    expect(output).toContain("findings:");
    expect(output).toContain("verify failed: node -e process.exit(2) (exit 2)");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T001");
    expect(pipeline.completed).not.toContain("T001");

    const patterns = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "failure-patterns.json"), "utf8"));
    expect(patterns.patterns[0]).toMatchObject({
      taskId: "T001",
      source: "local",
      verifyPassed: false,
      reviewPassed: true
    });
    expect(patterns.patterns[0].findings).toContain("verify failed: node -e process.exit(2) (exit 2)");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "continue T001", "--tool", "codex"]);
    const memoryPack = await readFile(join(projectPath, ".visp", "hyper", "current", "memory-pack.md"), "utf8");
    expect(memoryPack).toContain("## Known Failure Patterns");
    expect(memoryPack).toContain("verify failed: node -e process.exit(2) (exit 2)");
  });

  it("kit-present parity: Kit summaries remain advisory without an authoritative transition", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath);

    // A previously local session may later become Kit-backed. Checkpoint must
    // then preserve Kit authority without requiring direct start to bypass it.
    await writeTaskGraph(projectPath, ["pnpm typecheck"]);

    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: { id: "T001", title: "First task", status: "ready" }
        }
      },
      verify: { stdout: { success: true } },
      review: { stdout: { success: true } },
      reconcile: { stdout: { success: true } }
    });
    process.env.PATH = `${dirname(shim.binary)}${delimiter}${originalPath ?? ""}`;

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("evidence_source: kit");
    expect(output).toContain("verify: PASSED");
    expect(output).toContain("review: PASSED");
    expect(output).toContain("reconcile: PASSED");
    expect(output).toContain("assurance_level: advisory");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(output).toContain("reason_code: kit_post_checkpoint_transition_unavailable");
    expect(output).not.toContain("assurance_level: kit_strict");
    expect(output).not.toContain("next_task:");
    expect(output).not.toContain("pipeline_complete:");
    expect(output).not.toContain("instruction:");
    expect(output).not.toContain("BEGIN_VISP_ADAPTATION");
    expect(output).not.toContain("BEGIN_VISP_TASK_ACTION");

    const pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T001");
    expect(pipeline.completed).not.toContain("T001");
  });
});
