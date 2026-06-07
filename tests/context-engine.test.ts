import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRelevantFiles } from "../src/context/relevance-scanner.js";

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-context-"));
  await mkdir(join(projectPath, "src", "sync"), { recursive: true });
  await mkdir(join(projectPath, "tests"), { recursive: true });
  await mkdir(join(projectPath, ".visp", "specs"), { recursive: true });
  await mkdir(join(projectPath, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(join(projectPath, "src", "sync", "offline-sync.ts"), "export const sync = true;\n", "utf8");
  await writeFile(join(projectPath, "src", "sync", "engine.ts"), "export const engine = true;\n", "utf8");
  await writeFile(join(projectPath, "tests", "offline-sync.test.ts"), "import '../src/sync/offline-sync';\n", "utf8");
  await writeFile(join(projectPath, "tests", "engine.test.ts"), "import '../src/sync/engine';\n", "utf8");
  await writeFile(join(projectPath, ".env.local"), "SECRET=value\n", "utf8");
  await writeFile(join(projectPath, "node_modules", "pkg", "offline-sync.ts"), "ignored\n", "utf8");
  return projectPath;
}

describe("scanRelevantFiles", () => {
  it("selects goal keyword matches and project config files", async () => {
    const projectPath = await createProject();

    const files = await scanRelevantFiles({
      projectPath,
      goal: "implement offline sync",
      blockedPaths: [".env", ".env.*", "node_modules", ".git"]
    });

    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["README.md", "package.json", "src/sync/offline-sync.ts"])
    );
    expect(files.find((file) => file.path === "src/sync/offline-sync.ts")?.reason).toContain("matched goal keywords");
  });

  it("excludes blocked paths before selecting context", async () => {
    const projectPath = await createProject();

    const files = await scanRelevantFiles({
      projectPath,
      goal: "offline sync secret",
      blockedPaths: [".env", ".env.*", "node_modules", ".git"]
    });

    expect(files.map((file) => file.path)).not.toContain(".env.local");
    expect(files.map((file) => file.path)).not.toContain("node_modules/pkg/offline-sync.ts");
  });

  it("includes likely tests for matched source files", async () => {
    const projectPath = await createProject();

    const files = await scanRelevantFiles({
      projectPath,
      goal: "sync",
      blockedPaths: [".env", ".env.*", "node_modules", ".git"]
    });

    const testFile = files.find((file) => file.path === "tests/engine.test.ts");
    expect(testFile?.reason).toBe("likely test for src/sync/engine.ts");
  });

  it("selects files referenced by Visp-Kit artifacts and truncates large content", async () => {
    const projectPath = await createProject();
    const largeContent = "x".repeat(12_050);
    await writeFile(join(projectPath, "src", "referenced.ts"), largeContent, "utf8");
    await writeFile(
      join(projectPath, ".visp", "specs", "feature.md"),
      "Implementation should inspect src/referenced.ts even without goal keywords.\n",
      "utf8"
    );

    const files = await scanRelevantFiles({
      projectPath,
      goal: "unrelated goal",
      blockedPaths: [".env", ".env.*", "node_modules", ".git"]
    });

    const referenced = files.find((file) => file.path === "src/referenced.ts");
    expect(referenced?.reason).toBe("referenced by Visp-Kit artifact");
    expect(referenced?.content).toContain("[truncated]");
    expect(referenced?.content?.length).toBeLessThan(12_100);
  });
});
