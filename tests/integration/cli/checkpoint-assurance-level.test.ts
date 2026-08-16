// Non-negotiable rule 4 through the real CLI: on a project with no Kit at all,
// `visp-hyper checkpoint` must label its evidence `local_checked`.
//
// This is the one direction that cannot be checked without driving the command
// — the level is interpolated into the result block in `checkpoint.ts` itself,
// so no pure function owns the emitted string. The pure halves are pinned in
// `tests/unit/kit/workflow-action-assurance-level.test.ts` and
// `tests/unit/quality/kit-checkpoint-assurance-level.test.ts`.

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../src/cli/index.js";
import { execFileResolved } from "../../../src/core/executable-resolver.js";
import { checkpointBlockField } from "../../helpers/checkpoint-block.js";
import { toolOnlyPath } from "../../helpers/tool-path.js";

const originalPath = process.env.PATH;

describe("checkpoint on a project with no Kit at all", () => {
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

  it("emits local_checked, never kit_strict", async () => {
    const projectPath = await createRepo();

    // No `visp` on PATH: the Kit-less branch is the only one reachable.
    process.env.PATH = `${await toolOnlyPath(["git"])}${delimiter}`;
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "start",
      "implement T001",
      "--tool",
      "codex"
    ]);
    await injectPipeline(projectPath);

    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "checkpoint", "--task", "T001"]);
    const output = logs.join("\n");

    expect(checkpointBlockField(output, "evidence_source")).toBe("local");
    expect(checkpointBlockField(output, "assurance_level")).toBe("local_checked");
    expect(output).not.toContain("kit_strict");
  });
});

async function createRepo(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-assurance-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  await execFileResolved("git", ["init", "-b", "main"], { cwd: projectPath });
  await execFileResolved("git", ["add", "."], { cwd: projectPath });
  await execFileResolved(
    "git",
    ["-c", "user.name=Visp Test", "-c", "user.email=visp@example.test", "commit", "-m", "init"],
    { cwd: projectPath }
  );
  return projectPath;
}

async function injectPipeline(projectPath: string): Promise<void> {
  const statePath = join(projectPath, ".visp", "hyper", "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    activeSessionId: string;
    sessions: Record<string, Record<string, unknown>>;
  };
  state.sessions[state.activeSessionId]!.pipeline = {
    taskIds: ["T001"],
    currentTaskId: "T001",
    completed: [],
    stepHistory: [],
    syntheticTasks: [
      {
        id: "T001",
        title: "First task",
        description: "Implement the first task",
        dependsOn: [],
        allowedFiles: ["src/feature.ts"],
        validationCommands: ["node --version"],
        status: "ready"
      }
    ]
  };
  await writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
