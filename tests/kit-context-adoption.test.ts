import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { prepareStrictKitAdoption } from "../src/cli/commands/start.js";
import type { KitIntegrationContract } from "../src/kit/kit-schemas.js";
import { createVispShim } from "./helpers/visp-shim.js";
import { toolOnlyPath } from "./helpers/tool-path.js";

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-start-boundary-"));
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "feature.ts"), "export const value = 1;\n", "utf8");
  return projectPath;
}

async function addKitSignal(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, ".visp"), { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
}

function integrationContract(projectPath: string, taskId: string): KitIntegrationContract {
  const featureDir = "001-x";
  const contextPack = `.visp/features/${featureDir}/context/${taskId}.context.json`;
  const contextPrompt = `.visp/features/${featureDir}/context/${taskId}.prompt.md`;
  return {
    success: true,
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName: "visp", version: "0.1.1" },
    targetPath: projectPath,
    initialized: true,
    activeFeature: {
      id: "001",
      slug: "x",
      key: featureDir,
      path: `.visp/features/${featureDir}`
    },
    activeTask: { id: taskId, title: "Context task", status: "ready" },
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
      freshnessChecks: ["contextPack.artifactProvenance[]"],
      implementationReadSet: [
        ".visp/features/<feature>/context/<task-id>.context.json",
        ".visp/prompts/current-task.prompt.md",
        ".visp/policy.json"
      ]
    },
    artifacts: {
      kitSignals: [".visp/policy.json"],
      projectStatus: ".visp/status.json",
      projectProfile: ".visp/project.json",
      featureRoot: ".visp/features",
      featureDir: `.visp/features/${featureDir}`,
      taskGraph: `.visp/features/${featureDir}/task-graph.json`,
      contextPack,
      contextPrompt
    },
    orchestrator: {
      readContractVersion: "0.1",
      requiredArtifacts: [
        {
          id: "context-pack",
          path: contextPack,
          role: "task context",
          mimeType: "application/json",
          requiredFor: ["implementation"],
          freshness: "hash-pinned"
        },
        {
          id: "context-prompt",
          path: contextPrompt,
          role: "feature task prompt",
          mimeType: "text/markdown",
          requiredFor: ["implementation"],
          freshness: "read-latest"
        },
        {
          id: "current-task-prompt",
          path: ".visp/prompts/current-task.prompt.md",
          role: "current task prompt",
          mimeType: "text/markdown",
          requiredFor: ["implementation"],
          freshness: "read-latest"
        }
      ],
      freshnessPolicy: {
        contextPackHashPinned: true,
        provenanceArtifactsHashPinned: true,
        staleContextBlocks: ["implementation", "checkpoint", "pr"]
      }
    },
    warnings: []
  };
}

function promptArtifacts(projectPath: string, taskId: string) {
  return {
    prompt: {
      path: join(projectPath, ".visp", "features", "001-x", "context", `${taskId}.prompt.md`),
      sha256: "feature-prompt-hash"
    },
    currentPrompt: {
      path: join(projectPath, ".visp", "prompts", "current-task.prompt.md"),
      sha256: "current-prompt-hash"
    }
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("direct start Kit authority boundary", () => {
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

  it("blocks instead of adopting context when Kit is healthy", async () => {
    const projectPath = await createProject();
    await addKitSignal(projectPath);
    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          targetPath: ".",
          initialized: true,
          activeFeature: { id: "001", slug: "pipeline" },
          activeTask: { id: "T001", title: "First task", status: "ready" }
        }
      }
    });
    process.env.PATH = `${dirname(shim.binary)}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    expect(logs.join("\n")).toContain("reason_code: direct_start_requires_kitless_project");
    await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
    expect(process.exitCode).toBe(1);
  });

  it("is inconclusive instead of scanning locally when Kit is configured but unavailable", async () => {
    const projectPath = await createProject();
    await addKitSignal(projectPath);
    process.env.PATH = await toolOnlyPath(["git"]);

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    expect(logs.join("\n")).toContain("status: INCONCLUSIVE");
    expect(logs.join("\n")).toContain("reason_code: binary_not_found");
    await expect(readFile(join(projectPath, ".visp", "hyper", "state.json"), "utf8")).rejects.toThrow();
    expect(process.exitCode).toBe(1);
  });

  it("uses the local scanner only when Kit signals are genuinely absent", async () => {
    const projectPath = await createProject();
    process.env.PATH = await toolOnlyPath(["git"]);

    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature"]);

    expect(logs.join("\n")).toContain("BEGIN_VISP_AGENT_HANDOFF");
    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest.contextSource).toBe("visp-hyper relevance scanner");
    expect(process.exitCode).toBeFalsy();
  });

  it("accepts safe in-project symlinks and integrity-checked inline files", async () => {
    const projectPath = await createProject();
    await symlink(join(projectPath, "src", "feature.ts"), join(projectPath, "src", "safe-link.ts"));

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "src/safe-link.ts",
              reason: "safe in-project symlink",
              hash: sha256("export const value = 1;\n")
            },
            {
              path: "generated/missing.ts",
              reason: "inline planned file",
              content: "INLINE SAFE",
              hash: sha256("INLINE SAFE")
            }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption?.files).toEqual([
      expect.objectContaining({
        path: "src/safe-link.ts",
        content: "export const value = 1;\n"
      }),
      expect.objectContaining({
        path: "generated/missing.ts",
        content: "INLINE SAFE"
      })
    ]);
    expect(adoption?.warnings.filter((warning) => warning.includes("unsafe"))).toHaveLength(0);
  });

  it("rejects the entire authoritative pack when any declared entry is unsafe", async () => {
    const projectPath = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "visp-kit-secret-"));
    const outsideFile = join(outside, "secret.txt");
    await writeFile(outsideFile, "OUTSIDE SECRET CONTENT", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "src/feature.ts",
              reason: "safe authoritative source",
              hash: sha256("export const value = 1;\n")
            },
            { path: relative(projectPath, outsideFile), reason: "escaping path" }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("warning: Skipped an unsafe or unreadable context entry.");
  });

  it("rejects canonically duplicate authoritative context entries", async () => {
    const projectPath = await createProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const content = "export const value = 1;\n";

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            { path: "src/feature.ts", reason: "first alias", hash: sha256(content) },
            { path: "./src/feature.ts", reason: "second alias", hash: sha256(content) }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("warning: Rejected duplicate context file src/feature.ts.");
  });

  it("rejects whitespace-only authoritative source content", async () => {
    const projectPath = await createProject();
    const blankContent = " \n\t";
    await writeFile(join(projectPath, "src", "feature.ts"), blankContent, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "src/feature.ts",
              reason: "authoritative source",
              hash: sha256(blankContent)
            }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("warning: Rejected blank context file src/feature.ts.");
  });

  it("rejects authoritative source content whose SHA-256 does not match", async () => {
    const projectPath = await createProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "src/feature.ts",
              reason: "authoritative source",
              hash: sha256("different content\n")
            }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "warning: Rejected context file src/feature.ts: content did not match the authoritative SHA-256."
    );
  });

  it("accepts a missing planned file declared with the authoritative new-file sentinel", async () => {
    const projectPath = await createProject();

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "generated/new-feature.ts",
              reason: "planned task output",
              includeMode: "new-file",
              hash: "new-file"
            }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption?.files).toEqual([
      {
        path: "generated/new-feature.ts",
        reason: "planned task output",
        content: "Planned new file; no existing source content."
      }
    ]);
  });

  it("rejects a new-file sentinel when the target already exists", async () => {
    const projectPath = await createProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: {
          taskId: "T009",
          includedFiles: [
            {
              path: "src/feature.ts",
              reason: "planned task output",
              includeMode: "new-file",
              hash: "new-file"
            }
          ]
        }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "warning: Rejected planned new file src/feature.ts: the target already exists."
    );
  });

  it("preflights generated session destinations before initialization writes", async () => {
    const projectPath = await createProject();
    const outside = await mkdtemp(join(tmpdir(), "visp-start-outside-"));
    await symlink(outside, join(projectPath, ".visp"), "dir");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "start",
        "implement feature",
        "--tool",
        "codex"
      ])
    ).rejects.toThrow(/resolved path escapes/);

    expect(await readFile(join(projectPath, "README.md"), "utf8")).toBe("# Demo\n");
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects generated outputs that alias the same canonical file", async () => {
    const projectPath = await createProject();
    const current = join(projectPath, ".visp", "hyper", "current");
    const shared = join(current, "shared.md");
    await mkdir(current, { recursive: true });
    await writeFile(shared, "shared content", "utf8");
    await symlink(shared, join(current, "session.md"), "file");
    await symlink(shared, join(current, "context-pack.md"), "file");

    await expect(
      runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "start",
        "implement feature"
      ])
    ).rejects.toThrow(/managed output aliases/);

    expect(await readFile(shared, "utf8")).toBe("shared content");
  });

  it("applies configured blocked paths before publishing session outputs", async () => {
    const projectPath = await createProject();
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);

    const configPath = join(projectPath, ".visp", "hyper", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.blockedPaths.push(".visp/hyper/current");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    await expect(
      runCli([
        "node",
        "visp-hyper",
        "--project",
        projectPath,
        "start",
        "implement feature"
      ])
    ).rejects.toThrow(/blocked by project policy/);
  });

  it("surfaces a warning when every Kit context entry is rejected", async () => {
    const projectPath = await createProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const adoption = await prepareStrictKitAdoption(projectPath, {
      taskId: "T009",
      artifact: {
        path: join(projectPath, ".visp", "features", "001-x", "context", "T009.context.json"),
        sha256: "context-hash",
        ...promptArtifacts(projectPath, "T009"),
        pack: { taskId: "T009", includedFiles: [{ path: ".env", reason: "blocked" }] }
      },
      contract: integrationContract(projectPath, "T009")
    });

    expect(adoption).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("warning: Skipped an unsafe or unreadable context entry.");
  });
});
