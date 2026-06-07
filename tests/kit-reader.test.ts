import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readKitArtifacts } from "../src/kit/kit-reader.js";
import { renderContextPack } from "../src/output/markdown-writer.js";

describe("readKitArtifacts", () => {
  it("tolerates missing Visp-Kit artifacts with warnings", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-kit-missing-"));

    const artifacts = await readKitArtifacts(projectPath);

    expect(artifacts.constitution).toBeUndefined();
    expect(artifacts.rules).toEqual([]);
    expect(artifacts.specs).toEqual([]);
    expect(artifacts.warnings).toEqual(expect.arrayContaining(["Missing .visp/constitution.md."]));
  });

  it("summarizes available Visp-Kit markdown artifacts for context packs", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-kit-present-"));
    await mkdir(join(projectPath, ".visp", "specs"), { recursive: true });
    await mkdir(join(projectPath, ".visp", "rules"), { recursive: true });
    await writeFile(join(projectPath, ".visp", "constitution.md"), "# Constitution\n\nKeep tasks scoped.\n", "utf8");
    await writeFile(join(projectPath, ".visp", "specs", "feature.md"), "# Feature\n\nRead local memory files.\n", "utf8");
    await writeFile(join(projectPath, ".visp", "rules", "scope.md"), "# Scope\n\nNo unrelated edits.\n", "utf8");

    const artifacts = await readKitArtifacts(projectPath);
    const contextPack = renderContextPack([], artifacts);

    expect(artifacts.constitution?.summary).toBe("Keep tasks scoped.");
    expect(artifacts.specs[0]).toMatchObject({
      path: ".visp/specs/feature.md",
      summary: "Read local memory files."
    });
    expect(contextPack).toContain("Constitution: present - Keep tasks scoped.");
    expect(contextPack).toContain(".visp/specs/feature.md: Read local memory files.");
  });
});
