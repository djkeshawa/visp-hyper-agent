import { delimiter, dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { execFileResolved } from "../src/core/executable-resolver.js";
import { captureGitBaseline } from "../src/core/session-manager.js";
import type { GitBaseline } from "../src/core/types.js";
import { captureGitPathStates, collectChangedFiles } from "../src/governance/scope-guard.js";
import { initialPipelineState } from "../src/pipeline/pipeline-engine.js";
import { collectLocalEvidence as collectLocalEvidenceRaw } from "../src/quality/local-evidence.js";
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

type LocalEvidenceInput = Omit<
  Parameters<typeof collectLocalEvidenceRaw>[0],
  "baseline"
> & { baseline?: GitBaseline };

async function collectLocalEvidence(input: LocalEvidenceInput) {
  return collectLocalEvidenceRaw({
    ...input,
    baseline: input.baseline ?? (await captureGitBaseline(input.projectPath))
  });
}

describe("complete Git evidence inventory", () => {
  it("AC004: inventories committed, staged, unstaged, and nonignored untracked files", async () => {
    const projectPath = await createRepo();
    const baseline = await captureGitBaseline(projectPath);
    expect(baseline.kind).toBe("commit");

    await writeFile(join(projectPath, "src", "committed.ts"), "export const committed = 1;\n", "utf8");
    await stage(projectPath, "src/committed.ts");
    await commit(projectPath, "task commit");

    await writeFile(join(projectPath, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(projectPath, "src", "untracked.ts"), "export const untracked = 1;\n", "utf8");
    const newlinePath = "src/line\nbreak.ts";
    await writeFile(join(projectPath, newlinePath), "export const newline = 1;\n", "utf8");
    await writeFile(join(projectPath, ".git", "info", "exclude"), "ignored.ts\n", "utf8");
    await writeFile(join(projectPath, "ignored.ts"), "ignored\n", "utf8");

    const evidence = await collectChangedFiles(projectPath, { mode: "baseline", baseline });
    expect(evidence.ok).toBe(true);
    expect(evidence.warnings).toEqual([]);
    expect(evidence.committed).toEqual(["src/committed.ts"]);
    expect(evidence.staged).toEqual(["src/staged.ts"]);
    expect(evidence.unstaged).toEqual(["src/feature.ts"]);
    expect(evidence.untracked).toEqual([newlinePath, "src/untracked.ts"].sort());
    expect(new Set(evidence.files)).toEqual(
      new Set(["src/committed.ts", "src/staged.ts", "src/feature.ts", "src/untracked.ts", newlinePath])
    );
    expect(evidence.files).not.toContain("ignored.ts");

    if (baseline.kind === "commit") {
      const fromBase = await collectChangedFiles(projectPath, {
        mode: "base",
        baseRef: baseline.revision
      });
      expect(fromBase.ok).toBe(true);
      expect(fromBase).toMatchObject({
        committed: ["src/committed.ts"],
        staged: ["src/staged.ts"],
        unstaged: ["src/feature.ts"]
      });
      expect(fromBase.untracked).toEqual([newlinePath, "src/untracked.ts"].sort());
    }
  });

  it("AC004: preserves per-layer attribution while deduplicating the file union", async () => {
    const projectPath = await createRepo();
    const baseline = await captureGitBaseline(projectPath);
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await stage(projectPath, "src/feature.ts");
    await commit(projectPath, "first task change");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 3;\n", "utf8");
    await stage(projectPath, "src/feature.ts");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 4;\n", "utf8");

    const evidence = await collectChangedFiles(projectPath, { mode: "baseline", baseline });
    expect(evidence.ok).toBe(true);
    expect(evidence.committed).toEqual(["src/feature.ts"]);
    expect(evidence.staged).toEqual(["src/feature.ts"]);
    expect(evidence.unstaged).toEqual(["src/feature.ts"]);
    expect(evidence.files).toEqual(["src/feature.ts"]);
  });

  it("AC004: supports an unborn baseline before and after the first commit", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-unborn-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: projectPath });
    const baseline = await captureGitBaseline(projectPath);
    expect(baseline).toEqual({ kind: "unborn" });

    await writeFile(join(projectPath, "first.txt"), "first\n", "utf8");
    await stage(projectPath, "first.txt");
    const staged = await collectChangedFiles(projectPath, { mode: "baseline", baseline });
    expect(staged.ok).toBe(true);
    expect(staged.committed).toEqual([]);
    expect(staged.staged).toEqual(["first.txt"]);

    await commit(projectPath, "first commit");
    const committed = await collectChangedFiles(projectPath, { mode: "baseline", baseline });
    expect(committed.ok).toBe(true);
    expect(committed.committed).toEqual(["first.txt"]);
    expect(committed.staged).toEqual([]);
    expect(committed.files).toEqual(["first.txt"]);
  });

  it("AC004: does not classify an existing broken branch ref as unborn", async () => {
    const projectPath = await createRepo();
    await writeFile(
      join(projectPath, ".git", "refs", "heads", "main"),
      `${"f".repeat(40)}\n`,
      "utf8"
    );

    const captured = await captureGitBaseline(projectPath);
    expect(captured.kind).toBe("unavailable");

    const evidence = await collectChangedFiles(projectPath, {
      mode: "baseline",
      baseline: { kind: "unborn" }
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.files).toEqual([]);
    expect(evidence.warnings.some((warning) => warning.includes("unborn Git baseline"))).toBe(true);
  });

  it("AC004: rejects a malformed runtime baseline before invoking Git with it", async () => {
    const projectPath = await createRepo();
    const evidence = await collectChangedFiles(projectPath, {
      mode: "baseline",
      baseline: { kind: "commit", revision: "--output=/tmp/not-allowed" }
    });
    expect(evidence.ok).toBe(false);
    expect(evidence.files).toEqual([]);
    expect(evidence.warnings.join(" ")).toContain("not an exact 40- or 64-character object id");
  });

  it.skipIf(process.platform === "win32")(
    "AC004: literal POSIX backslash paths fail closed instead of resolving another file",
    async () => {
      const projectPath = await createRepo();
      const literalPath = "src\\literal.ts";
      await writeFile(join(projectPath, literalPath), "export const literal = 1;\n", "utf8");

      const evidence = await collectChangedFiles(projectPath, { mode: "all" });
      expect(evidence.ok).toBe(true);
      expect(evidence.files).toContain(literalPath);
      const state = await captureGitPathStates(projectPath, [literalPath]);
      expect(state.ok).toBe(false);
      if (!state.ok) {
        expect(state.warning).toContain("not canonical for project-file resolution");
      }
    }
  );
});

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

  it("AC004: a nonignored untracked canonical Visp file remains protected", async () => {
    const projectPath = await createRepo();
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", allowedFiles: ["src"], validationCommands: ["node --version"] },
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

  it("AC004: empty evidence fails unless it is explicitly allowed", async () => {
    const projectPath = await createRepo();
    const failed = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node --version"] },
      blockedPaths: []
    });
    expect(failed.reviewVerdict).toBe("failed");
    expect(failed.findings).toContain(
      "review failed: no attributable changes detected; use --allow-empty only when intentional"
    );

    const allowed = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node --version"] },
      blockedPaths: [],
      allowEmpty: true
    });
    expect(allowed.reviewVerdict).toBe("passed");
    expect(allowed.findings).toContain("no attributable changes detected (explicitly allowed)");
  });

  it("AC004: --allow-empty never overrides an unavailable Git baseline", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-evidence-nogit-"));
    const baseline = await captureGitBaseline(projectPath);
    expect(baseline.kind).toBe("unavailable");

    const evidence = await collectLocalEvidence({
      projectPath,
      task: { id: "T001", validationCommands: ["node --version"] },
      blockedPaths: [],
      baseline,
      allowEmpty: true
    });
    expect(evidence.reviewVerdict).toBe("inconclusive");
    expect(evidence.reviewPassed).toBe(false);
    expect(evidence.findings.join(" ")).toContain("complete Git evidence is unavailable");
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
    process.exitCode = undefined;
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
    const synthetic = validationCommands !== undefined;
    const tasks = [
      {
        id: "T001",
        title: "First task",
        description: "Implement the first task",
        dependsOn: [],
        allowedFiles: ["src/feature.ts"],
        validationCommands: validationCommands ?? ["pnpm typecheck"],
        status: "ready"
      },
      {
        id: "T002",
        title: "Second task",
        ...(synthetic
          ? {
              description: "Implement the second task",
              status: "pending",
              validationCommands: validationCommands ?? ["pnpm typecheck"]
            }
          : {}),
        dependsOn: ["T001"],
        allowedFiles: ["src/other.ts"]
      }
    ];
    const graph = synthetic
      ? { tasks }
      : { featureId: "001", featureSlug: "pipeline", tasks };
    const identity = synthetic
      ? { kind: "synthetic" as const, source: `quick:${sessionId}` }
      : {
          kind: "visp-kit" as const,
          source: `.visp/features/${FEATURE_DIR}/task-graph.json`,
          featureId: "001",
          featureSlug: "pipeline"
        };
    state.sessions[sessionId].pipeline = {
      ...initialPipelineState(graph, identity),
      gitBaseline: state.sessions[sessionId].gitBaseline,
      ...(synthetic ? { syntheticTasks: tasks } : {})
    };
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
  }

  async function readPipeline(projectPath: string): Promise<any> {
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    return state.sessions[state.activeSessionId].pipeline;
  }

  it("AC004: a newly attached pipeline pins its session Git baseline", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "quick",
      "pin baseline",
      "--files",
      "src/feature.ts"
    ]);
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    const session = state.sessions[state.activeSessionId];
    expect(session.gitBaseline.kind).toBe("commit");
    expect(session.pipeline.gitBaseline).toEqual(session.gitBaseline);
  });

  it("AC004: checkpoint fails on empty evidence and advances only with --allow-empty", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    let output = logs.join("\n");
    expect(output).toContain("reason_code: empty_git_evidence");
    expect(output).toContain("status: FAILED");
    expect(process.exitCode).toBe(1);
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T001");

    process.exitCode = undefined;
    logs = [];
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "checkpoint",
      "--task",
      "T001",
      "--allow-empty"
    ]);
    output = logs.join("\n");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("next_task: T002");
    expect(process.exitCode).toBeUndefined();
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T002");
  });

  it("AC004: checkpoint --allow-empty cannot override a Git failure", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-checkpoint-nogit-"));
    await mkdir(join(projectPath, "src"), { recursive: true });
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    logs = [];
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "checkpoint",
      "--task",
      "T001",
      "--allow-empty"
    ]);
    const output = logs.join("\n");
    expect(output).toContain("reason_code: git_evidence_unavailable");
    expect(output).toContain("status: INCONCLUSIVE");
    expect(process.exitCode).toBe(1);
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T001");
  });

  it("AC004: a committed out-of-scope change remains checkpoint evidence", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement T001", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "committed.ts"), "export const outside = 1;\n", "utf8");
    await stage(projectPath, "lib/committed.ts");
    await commit(projectPath, "out of scope task change");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("scope violation: lib/committed.ts outside allowed files");
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T001");
    const checkpoint = await readFile(
      join(projectPath, ".visp", "hyper", "current", "checkpoints.md"),
      "utf8"
    );
    const snapshot = JSON.parse(
      await readFile(
        join(projectPath, ".visp", "hyper", "current", "checkpoint-snapshot.json"),
        "utf8"
      )
    );
    expect(checkpoint).toContain("- lib/committed.ts");
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({ path: "lib/committed.ts", exists: true })
    );
    expect(snapshot.warnings).toContain(
      "Resume delta comparison observes working/index changes only; committed-only checkpoint paths may appear as cleared."
    );
  });

  it("AC004: checkpoint reviews files created by validation before advancing", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "validate T001", "--tool", "codex"]);
    await injectPipeline(projectPath, [
      "node -e require('node:fs').mkdirSync('lib',{recursive:true});require('node:fs').writeFileSync('lib/generated.ts','generated')"
    ]);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("scope violation: lib/generated.ts outside allowed files");
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T001");

    const checkpoint = await readFile(
      join(projectPath, ".visp", "hyper", "current", "checkpoints.md"),
      "utf8"
    );
    const snapshot = JSON.parse(
      await readFile(
        join(projectPath, ".visp", "hyper", "current", "checkpoint-snapshot.json"),
        "utf8"
      )
    );
    expect(checkpoint).toContain("- lib/generated.ts");
    expect(snapshot.files).toContainEqual(
      expect.objectContaining({ path: "lib/generated.ts", exists: true })
    );
  });

  it("AC004: standalone review includes committed changes and omits Hyper runtime", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "start",
      "review complete evidence",
      "--tool",
      "codex"
    ]);
    const statePath = join(projectPath, ".visp", "hyper", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.sessions[state.activeSessionId].relevantFiles = ["src/feature.ts"];
    await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
    await mkdir(join(projectPath, "lib"), { recursive: true });
    await writeFile(join(projectPath, "lib", "committed.ts"), "export const outside = 1;\n", "utf8");
    await stage(projectPath, "lib/committed.ts");
    await commit(projectPath, "committed review evidence");

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "review"]);
    const output = logs.join("\n");
    expect(output).toContain("changed_files: 1");
    expect(output).toContain("outside_relevant_files: 1");
    const report = await readFile(
      join(projectPath, ".visp", "hyper", "current", "review-report.md"),
      "utf8"
    );
    expect(report).toContain("- lib/committed.ts");
    expect(report).not.toContain(".visp/hyper/");
  });

  it("AC004: remember records the complete baseline inventory", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "remember changes", "--tool", "codex"]);

    await writeFile(join(projectPath, "src", "committed.ts"), "export const committed = 1;\n", "utf8");
    await stage(projectPath, "src/committed.ts");
    await commit(projectPath, "remember committed change");
    await writeFile(join(projectPath, "src", "staged.ts"), "export const staged = 1;\n", "utf8");
    await stage(projectPath, "src/staged.ts");
    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(projectPath, "src", "untracked.ts"), "export const untracked = 1;\n", "utf8");

    logs = [];
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "remember",
      "--summary",
      "complete evidence"
    ]);
    const state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    const memory = await readFile(
      join(projectPath, ".visp", "memory", "session-history", `${state.activeSessionId}.md`),
      "utf8"
    );
    expect(memory).toContain("- src/committed.ts");
    expect(memory).toContain("- src/staged.ts");
    expect(memory).toContain("- src/feature.ts");
    expect(memory).toContain("- src/untracked.ts");
  });

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

  it("AC004: each passed task refreshes only the pipeline baseline", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement two tasks", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    await stage(projectPath, "src/feature.ts");
    await commit(projectPath, "complete T001");
    const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectPath });
    const t001Head = headOutput.trim();

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    expect(logs.join("\n")).toContain("status: PASSED");

    let state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    let session = state.sessions[state.activeSessionId];
    expect(session.pipeline.currentTaskId).toBe("T002");
    expect(session.pipeline.gitBaseline).toEqual({ kind: "commit", revision: t001Head });
    expect(session.gitBaseline).not.toEqual(session.pipeline.gitBaseline);

    await writeFile(join(projectPath, "src", "other.ts"), "export const other = 1;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T002"]);
    const output = logs.join("\n");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("pipeline_complete: true");
    expect(output).not.toContain("scope violation: src/feature.ts outside allowed files");

    state = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8"));
    session = state.sessions[state.activeSessionId];
    expect(session.pipeline.currentTaskId).toBeNull();
    expect(session.pipeline.completed).toEqual(["T001", "T002"]);
    expect(session.gitBaseline).not.toEqual(session.pipeline.gitBaseline);
  });

  it("AC004: unchanged uncommitted work from a passed task is not charged to the next task", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "uncommitted tasks", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    expect(logs.join("\n")).toContain("status: PASSED");

    let pipeline = await readPipeline(projectPath);
    expect(pipeline.currentTaskId).toBe("T002");
    expect(pipeline.gitBaseline.settledPaths).toHaveProperty("src/feature.ts");

    await writeFile(join(projectPath, "src", "other.ts"), "export const other = 1;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T002"]);
    const output = logs.join("\n");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("pipeline_complete: true");
    expect(output).not.toContain("scope violation: src/feature.ts outside allowed files");
    pipeline = await readPipeline(projectPath);
    expect(pipeline.completed).toEqual(["T001", "T002"]);
  });

  it("AC004: committing reviewed work after its checkpoint keeps it settled", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "commit between tasks", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    expect(logs.join("\n")).toContain("status: PASSED");

    await stage(projectPath, "src/feature.ts");
    await commit(projectPath, "commit reviewed T001 work");
    await writeFile(join(projectPath, "src", "other.ts"), "export const other = 1;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T002"]);
    const output = logs.join("\n");
    expect(output).toContain("status: PASSED");
    expect(output).toContain("pipeline_complete: true");
    expect(output).not.toContain("scope violation: src/feature.ts outside allowed files");
  });

  it("AC004: changing a previously settled path makes it attributable again", async () => {
    const projectPath = await createRepo();
    process.env.PATH = await gitNodeOnlyPath();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "changed settled path", "--tool", "codex"]);
    await injectPipeline(projectPath, ["node --version"]);

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 2;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    expect(logs.join("\n")).toContain("status: PASSED");

    await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 3;\n", "utf8");
    await writeFile(join(projectPath, "src", "other.ts"), "export const other = 1;\n", "utf8");
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T002"]);
    const output = logs.join("\n");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("scope violation: src/feature.ts outside allowed files");
    expect((await readPipeline(projectPath)).currentTaskId).toBe("T002");
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

  it("kit-present parity: incomplete Kit authority remains fail closed", async () => {
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
          targetPath: projectPath,
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
    expect(output).toContain("verify: INCONCLUSIVE");
    expect(output).toContain("review: INCONCLUSIVE");
    expect(output).toContain("assurance_level: advisory");
    expect(output).toContain("status: FAILED");
    expect(output).toContain("reason_code: context_freshness_failed");
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
