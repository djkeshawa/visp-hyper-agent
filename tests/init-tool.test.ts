import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createVispShim } from "./helpers/visp-shim.js";

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "visp-init-"));
}

async function writeKitArtifacts(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

function initializedKitStatus(projectPath: string): Record<string, unknown> {
  return {
    success: true,
    targetPath: projectPath,
    initialized: true,
    activeFeature: { id: "001", slug: "pipeline" },
    activeTask: { id: "T001", title: "First task", status: "ready" },
    featureState: "ready"
  };
}

describe("init --tool asset installation and hook wiring", () => {
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

  it("AC004: installs claude-code assets, renders model token, and is idempotent on re-run", async () => {
    const projectPath = await createProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));

    await runCli(["node", "visp-hyper", "--project", projectPath, "init", "--tool", "claude-code"]);

    const agents = ["coordinator.md", "scout.md", "implementer.md"];
    for (const agent of agents) {
      expect(await fileExists(join(projectPath, ".claude", "agents", agent))).toBe(true);
    }
    const commands = [
      "hyper-run.md",
      "hyper-next.md",
      "hyper-checkpoint.md",
      "hyper-review.md",
      "hyper-remember.md"
    ];
    for (const command of commands) {
      expect(await fileExists(join(projectPath, ".claude", "commands", command))).toBe(true);
    }

    const coordinator = await readFile(join(projectPath, ".claude", "agents", "coordinator.md"), "utf8");
    expect(coordinator).toContain("model: inherit");

    const output = logs.join("\n");
    expect(output).toContain("Installed claude-code assets:");
    expect(output).toContain("created: .claude/agents/coordinator.md");
    expect(output).toContain("created: .claude/commands/hyper-run.md");

    // Re-run: everything already exists, so all are skipped and contents are unchanged.
    logs = [];
    await runCli(["node", "visp-hyper", "--project", projectPath, "init", "--tool", "claude-code"]);
    const rerunOutput = logs.join("\n");
    expect(rerunOutput).toContain("skipped (exists): .claude/agents/coordinator.md");
    expect(rerunOutput).not.toContain("created: .claude/agents/coordinator.md");

    const coordinatorAfter = await readFile(join(projectPath, ".claude", "agents", "coordinator.md"), "utf8");
    expect(coordinatorAfter).toBe(coordinator);
  });

  it("AC005: installs codex and copilot assets; plain init prints only the init line", async () => {
    const codexProject = await createProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    await runCli(["node", "visp-hyper", "--project", codexProject, "init", "--tool", "codex"]);
    expect(await fileExists(join(codexProject, "AGENTS.visp-hyper.md"))).toBe(true);
    expect(await fileExists(join(codexProject, ".agents", "skills", "visp-hyper", "SKILL.md"))).toBe(true);
    expect(
      JSON.parse(await readFile(join(codexProject, ".visp", "hyper", "config.json"), "utf8"))
        .defaultTool
    ).toBe("codex");

    logs = [];
    const copilotProject = await createProject();
    await runCli(["node", "visp-hyper", "--project", copilotProject, "init", "--tool", "copilot"]);
    expect(
      await fileExists(join(copilotProject, ".github", "instructions", "visp-hyper.instructions.md"))
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(copilotProject, ".visp", "hyper", "config.json"), "utf8"))
        .defaultTool
    ).toBe("copilot");

    logs = [];
    const plainProject = await createProject();
    await runCli(["node", "visp-hyper", "--project", plainProject, "init"]);
    expect(logs).toEqual([`Initialized Visp Hyper at ${plainProject}`]);
    const plainOutput = logs.join("\n");
    expect(plainOutput).not.toContain("Installed");
    expect(plainOutput).not.toContain("hint:");
  });

  it("AC006: prints hook hint when kit is present; installs hook with --with-hooks; silent without kit", async () => {
    // Kit present, no --with-hooks → hint only.
    const hintProject = await createProject();
    await writeKitArtifacts(hintProject);
    const hintShim = await createVispShim({
      status: { stdout: initializedKitStatus(hintProject) }
    });
    prependToPath(dirname(hintShim.binary));
    await runCli(["node", "visp-hyper", "--project", hintProject, "init", "--tool", "claude-code"]);
    expect(logs.join("\n")).toContain("visp hooks claude");
    expect(logs.join("\n")).toContain("hint:");

    // Kit present, --with-hooks, shim answers hooks → installed.
    logs = [];
    const installProject = await createProject();
    await writeKitArtifacts(installProject);
    const installShim = await createVispShim({
      status: { stdout: initializedKitStatus(installProject) },
      hooks: { stdout: { success: true } }
    });
    prependToPath(dirname(installShim.binary));
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      installProject,
      "init",
      "--tool",
      "claude-code",
      "--with-hooks"
    ]);
    expect(logs.join("\n")).toContain("hooks: installed");

    // No kit on PATH → no hook mention at all.
    logs = [];
    const silentProject = await createProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    await runCli(["node", "visp-hyper", "--project", silentProject, "init", "--tool", "claude-code"]);
    const silentOutput = logs.join("\n");
    expect(silentOutput).not.toContain("hooks:");
    expect(silentOutput).not.toContain("hint:");
  });

  it("AC006: warns (does not install or throw) when --with-hooks hook output is unparseable", async () => {
    const garbageProject = await createProject();
    await writeKitArtifacts(garbageProject);
    // `hooks` emits a STRING → non-JSON → hooksClaude() parses to null → warn branch.
    const garbageShim = await createVispShim({
      status: { stdout: initializedKitStatus(garbageProject) },
      hooks: { stdout: "<<garbage>>" }
    });
    prependToPath(dirname(garbageShim.binary));

    await expect(
      runCli([
        "node",
        "visp-hyper",
        "--project",
        garbageProject,
        "init",
        "--tool",
        "claude-code",
        "--with-hooks"
      ])
    ).resolves.toBeUndefined();

    const output = logs.join("\n");
    expect(output).toContain("warning: visp hooks claude failed; run it manually.");
    expect(output).not.toContain("hooks: installed");
  });

  it("AC006: warns when --with-hooks hook output reports success:false", async () => {
    const failProject = await createProject();
    await writeKitArtifacts(failProject);
    // `hooks` returns valid JSON with success:false → hooksClaude() returns {success:false} → warn branch.
    const failShim = await createVispShim({
      status: { stdout: initializedKitStatus(failProject) },
      hooks: { stdout: { success: false } }
    });
    prependToPath(dirname(failShim.binary));

    await runCli([
      "node",
      "visp-hyper",
      "--project",
      failProject,
      "init",
      "--tool",
      "claude-code",
      "--with-hooks"
    ]);

    const output = logs.join("\n");
    expect(output).toContain("warning: visp hooks claude failed; run it manually.");
    expect(output).not.toContain("hooks: installed");
  });
});
