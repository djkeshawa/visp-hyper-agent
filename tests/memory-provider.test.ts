import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileMemoryProvider, readMemoryPack, writeSessionMemory } from "../src/memory/file-memory-provider.js";
import { renderMemoryPack } from "../src/output/markdown-writer.js";

describe("FileMemoryProvider", () => {
  it("tolerates missing memory and renders warnings", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-memory-missing-"));

    const pack = await readMemoryPack(projectPath);
    const markdown = renderMemoryPack(pack);

    expect(pack.files).toEqual([]);
    expect(pack.warnings).toContain("No local Visp memory markdown files found.");
    expect(markdown).toContain("No local Visp memory files found yet.");
  });

  it("reads memory files with summaries and supports recall/profile boundaries", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-memory-read-"));
    await mkdir(join(projectPath, ".visp", "memory"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "memory", "project-summary.md"), "# Project\n\nOffline notes app.\n", "utf8");
    await writeFile(join(projectPath, ".visp", "memory", "known-risks.md"), "# Risks\n\nSync conflicts need care.\n", "utf8");
    const provider = new FileMemoryProvider(projectPath);

    const pack = await provider.readPack();
    const recall = await provider.recall("conflicts", { limit: 1 });
    const profile = await provider.getProjectProfile(projectPath);

    expect(pack.files.map((file) => file.path)).toEqual([
      ".visp/memory/known-risks.md",
      ".visp/memory/project-summary.md"
    ]);
    expect(pack.files.find((file) => file.path.endsWith("known-risks.md"))?.summary).toBe("Sync conflicts need care.");
    expect(recall).toHaveLength(1);
    expect(recall[0]?.path).toBe(".visp/memory/known-risks.md");
    expect(profile?.summary).toContain("Offline notes app.");
  });

  it("writes useful session memory and decisions", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-memory-write-"));
    const path = await writeSessionMemory({
      projectPath,
      sessionId: "vh_test",
      goal: "implement sync",
      summary: "Added sync support.",
      timestamp: "2026-06-07T00:00:00.000Z",
      changedFiles: ["src/sync.ts"],
      reviewSummary: "Review passed.",
      decisions: ["Use file memory first."],
      followUps: ["Add semantic recall later."]
    });
    const provider = new FileMemoryProvider(projectPath);
    await provider.storeDecision({
      title: "Memory Backend",
      decision: "Keep MVP file-backed.",
      timestamp: "2026-06-07T00:00:00.000Z"
    });

    const sessionMemory = await readFile(path, "utf8");
    const decisions = await readFile(join(projectPath, ".visp", "memory", "architecture-decisions.md"), "utf8");

    expect(sessionMemory).toContain("Timestamp: 2026-06-07T00:00:00.000Z");
    expect(sessionMemory).toContain("- src/sync.ts");
    expect(sessionMemory).toContain("Review passed.");
    expect(sessionMemory).toContain("- Use file memory first.");
    expect(sessionMemory).toContain("- Add semantic recall later.");
    expect(decisions).toContain("## Memory Backend");
    expect(decisions).toContain("Keep MVP file-backed.");
  });

  it("uses a fence longer than any embedded Markdown fence", () => {
    const content = ["before", "```", "nested", "```", "after"].join("\n");
    const markdown = renderMemoryPack({
      files: [{ path: ".visp/memory/nested.md", content, summary: "nested" }],
      warnings: []
    });

    expect(markdown).toContain(["````", content, "````"].join("\n"));
    expect(markdown.match(/^````$/gmu)).toHaveLength(2);
  });
});
