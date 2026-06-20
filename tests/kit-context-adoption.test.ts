import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { createVispShim } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);

const originalPath = process.env.PATH;

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-kit-adopt-"));
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

async function writeContextPack(projectPath: string, options: { provenance?: boolean } = {}): Promise<void> {
  const contextDir = join(projectPath, ".visp", "features", "001-x", "context");
  const includeProvenance = options.provenance ?? true;
  await mkdir(contextDir, { recursive: true });
  await writeFile(join(projectPath, ".visp", "policy.json"), "{}\n", "utf8");
  await writeFile(
    join(contextDir, "T009.context.json"),
    JSON.stringify({
      taskId: "T009",
      includedFiles: [
        { path: "src/feature.ts", reason: "task target", hash: "abc123" },
        { path: ".env", reason: "secrets file" }
      ],
      ...(includeProvenance
        ? {
            artifactProvenance: [
              {
                label: "spec",
                path: ".visp/features/001-x/spec.json",
                hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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

function prependToPath(dir: string): void {
  process.env.PATH = `${dir}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;
}

describe("kit context-pack adoption in start", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  it("AC007: adopts the on-disk context pack when visp is available with an active task", async () => {
    const projectPath = await createProject();
    await writeContextPack(projectPath);

    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "x" },
          activeTask: { id: "T009", title: "Adopt context pack", status: "ready" }
        }
      }
    });
    prependToPath(dirname(shim.binary));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);

    const contextPack = await readFile(join(projectPath, ".visp", "hyper", "current", "context-pack.md"), "utf8");
    expect(contextPack).toContain("Source: visp-kit context pack (T009)");
    expect(contextPack).toContain("src/feature.ts");
    expect(contextPack).toContain("pnpm typecheck");
    expect(contextPack).toContain("pnpm test");
    expect(contextPack).not.toContain(".env");

    const handoff = JSON.parse(await readFile(join(projectPath, ".visp", "hyper", "current", "handoff.json"), "utf8"));
    expect(handoff.session.relevantFiles).toEqual(["src/feature.ts"]);

    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest).toMatchObject({
      contextSource: "visp-kit context pack (T009)",
      taskId: "T009",
      validationCommands: ["pnpm typecheck", "pnpm test"],
      nextCommand: "visp-hyper checkpoint --task T009"
    });
    expect(manifest.contextArtifact).toMatchObject({
      path: ".visp/features/001-x/context/T009.context.json",
      hashAlgorithm: "sha256"
    });
    expect(manifest.contextArtifact.hash).toHaveLength(64);
    expect(manifest.artifactProvenance).toEqual([
      {
        label: "spec",
        path: ".visp/features/001-x/spec.json",
        hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        hashAlgorithm: "sha256",
        source: "visp-kit"
      }
    ]);
    expect(manifest).not.toHaveProperty("freshnessWarnings");
    expect(manifest.selectedFiles).toEqual([
      expect.objectContaining({
        path: "src/feature.ts",
        reason: "task target",
        hasContent: true,
        sourceHash: "abc123",
        sourceHashAlgorithm: "sha256",
        sourceHashSource: "visp-kit"
      })
    ]);
  });

  it("surfaces a freshness warning when an adopted Kit context pack has no provenance", async () => {
    const projectPath = await createProject();
    await writeContextPack(projectPath, { provenance: false });

    const shim = await createVispShim({
      status: {
        stdout: {
          success: true,
          initialized: true,
          activeFeature: { id: "001", slug: "x" },
          activeTask: { id: "T009", title: "Adopt context pack", status: "ready" }
        }
      }
    });
    prependToPath(dirname(shim.binary));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);

    const contextPack = await readFile(join(projectPath, ".visp", "hyper", "current", "context-pack.md"), "utf8");
    expect(contextPack).toContain("has no artifactProvenance");
    expect(contextPack).toContain("checkpoint can pin only the context-pack file");

    const manifest = JSON.parse(
      await readFile(join(projectPath, ".visp", "hyper", "current", "context-manifest.json"), "utf8")
    );
    expect(manifest).not.toHaveProperty("artifactProvenance");
    expect(manifest.freshnessWarnings).toEqual([
      expect.stringContaining("has no artifactProvenance")
    ]);
  });

  it("AC008: falls back to the scanner with byte-identical output when visp is not on PATH", async () => {
    const projectPath = await createProject();
    await writeContextPack(projectPath);

    // A directory guaranteed to contain no `visp` binary.
    const emptyDir = await mkdtemp(join(tmpdir(), "visp-empty-"));
    process.env.PATH = emptyDir;

    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);

    const contextPack = await readFile(join(projectPath, ".visp", "hyper", "current", "context-pack.md"), "utf8");
    expect(contextPack).not.toContain("Source: visp-kit context pack");
    expect(/matched goal keywords|project config or README/.test(contextPack)).toBe(true);
  });

  it("falls back to the scanner when visp is available but has no active task", async () => {
    const projectPath = await createProject();
    await writeContextPack(projectPath);

    const shim = await createVispShim({
      status: { stdout: { success: true, initialized: true } }
    });
    prependToPath(dirname(shim.binary));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "visp-hyper", "--project", projectPath, "init"]);
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "implement feature", "--tool", "codex"]);

    const contextPack = await readFile(join(projectPath, ".visp", "hyper", "current", "context-pack.md"), "utf8");
    expect(contextPack).not.toContain("Source: visp-kit context pack");
    expect(/matched goal keywords|project config or README/.test(contextPack)).toBe(true);
  });
});
