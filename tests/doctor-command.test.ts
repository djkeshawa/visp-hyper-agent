import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createVispShim } from "./helpers/visp-shim.js";

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-doctor-"));
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "hyper", "config.json"), "{}\n", "utf8");
  await writeFile(join(projectPath, ".visp", "hyper", "state.json"), "{}\n", "utf8");
  return projectPath;
}

async function writeKitArtifacts(projectPath: string): Promise<void> {
  const contextDir = join(projectPath, ".visp", "features", "001-demo", "context");
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  await writeFile(
    join(contextDir, "T001.context.json"),
    JSON.stringify({
      taskId: "T001",
      includedFiles: [{ path: "src/feature.ts", reason: "task target", content: "export {};\n" }],
      validationCommands: ["pnpm test"]
    }),
    "utf8"
  );
}

async function writeHyperGitHook(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".git", "hooks"), { recursive: true });
  await writeFile(join(projectPath, ".git", "hooks", "pre-commit"), "# visp-hyper-guard hook\n", "utf8");
}

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

describe("doctor command", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("checks the healthy Visp Kit bridge path", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    await writeHyperGitHook(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "demo" },
          activeTask: { id: "T001", title: "Demo task", status: "ready" }
        }
      },
      policy: { stdout: { success: true, errors: [] } },
      gate: { stdout: { success: true, stage: "next", allowed: true, failedRules: [] } }
    });
    prependToPath(dirname(shim.binary));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string; detail: string }>;
    };
    expect(summary.success).toBe(true);
    expect(summary.checks.find((check) => check.id === "kit-binary")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-policy")?.status).toBe("pass");
    expect(summary.checks.find((check) => check.id === "kit-context-pack")?.detail).toContain("T001");
    expect(summary.checks.find((check) => check.id === "git-hook")?.status).toBe("pass");

    const argvLog = await readFile(shim.argvLogPath, "utf8");
    expect(argvLog).toContain('["policy","validate","--json"]');
    expect(argvLog).toContain('["gate","next","--json"]');
  });

  it("warns, but does not fail, when the strict Kit backend is absent", async () => {
    const projectPath = await createProject();

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string }>;
      nextCommand: string;
    };
    expect(summary.success).toBe(true);
    expect(summary.checks.find((check) => check.id === "kit-artifacts")?.status).toBe("warn");
    expect(summary.nextCommand).toContain("visp init");
  });

  it("fails when Kit artifacts exist but the visp binary cannot be executed", async () => {
    const projectPath = await createProject();
    await writeKitArtifacts(projectPath);
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-path-"));

    await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);

    const summary = JSON.parse(logs.join("")) as {
      success: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(summary.success).toBe(false);
    expect(summary.checks.find((check) => check.id === "kit-binary")?.status).toBe("fail");
    expect(process.exitCode).toBe(1);
  });
});
