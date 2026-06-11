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

    logs = [];
    const copilotProject = await createProject();
    await runCli(["node", "visp-hyper", "--project", copilotProject, "init", "--tool", "copilot"]);
    expect(
      await fileExists(join(copilotProject, ".github", "instructions", "visp-hyper.instructions.md"))
    ).toBe(true);

    logs = [];
    const plainProject = await createProject();
    await runCli(["node", "visp-hyper", "--project", plainProject, "init"]);
    expect(logs).toEqual([`Initialized Visp Hyper at ${plainProject}`]);
    const plainOutput = logs.join("\n");
    expect(plainOutput).not.toContain("Installed");
    expect(plainOutput).not.toContain("hint:");
  });

  it("AC006: prints hook hint when kit is present; installs hook with --with-hooks; silent without kit", async () => {
    const initializedSpec = {
      status: { stdout: { success: true, initialized: true } }
    };

    // Kit present, no --with-hooks → hint only.
    const hintProject = await createProject();
    await writeKitArtifacts(hintProject);
    const hintShim = await createVispShim(initializedSpec);
    prependToPath(dirname(hintShim.binary));
    await runCli(["node", "visp-hyper", "--project", hintProject, "init", "--tool", "claude-code"]);
    expect(logs.join("\n")).toContain("visp hooks claude");
    expect(logs.join("\n")).toContain("hint:");

    // Kit present, --with-hooks, shim answers hooks → installed.
    logs = [];
    const installProject = await createProject();
    await writeKitArtifacts(installProject);
    const installShim = await createVispShim({
      ...initializedSpec,
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
});
