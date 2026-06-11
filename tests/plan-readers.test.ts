import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlanTaskGraph,
  parseChecklist,
  readGenericChecklist,
  readOpenSpec,
  readSpecKit
} from "../src/plan/plan-readers.js";
import { loadTaskGraph } from "../src/pipeline/pipeline-engine.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vh-plan-"));
}

async function writeAt(projectPath: string, relPath: string, content: string): Promise<void> {
  const full = join(projectPath, relPath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

describe("parseChecklist (AC004a)", () => {
  it("turns mixed checked/unchecked items into a linear chain", () => {
    const content = [
      "# My plan",
      "",
      "- [x] First thing",
      "- [ ] Second thing",
      "* [X] Third thing",
      "",
      "Some prose that is not a checklist line."
    ].join("\n");

    const tasks = parseChecklist(content);

    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.id)).toEqual(["P001", "P002", "P003"]);
    expect(tasks.map((t) => t.title)).toEqual(["First thing", "Second thing", "Third thing"]);
    expect(tasks.map((t) => t.status)).toEqual(["verified", "pending", "verified"]);
    expect(tasks[0]?.dependsOn).toEqual([]);
    expect(tasks[1]?.dependsOn).toEqual(["P001"]);
    expect(tasks[2]?.dependsOn).toEqual(["P002"]);
  });

  it("honors a custom idPrefix", () => {
    const tasks = parseChecklist("- [ ] only", { idPrefix: "X" });
    expect(tasks[0]?.id).toBe("X001");
  });

  it("captures indented continuation lines as the description", () => {
    const content = [
      "- [ ] Build the thing",
      "    More detail about building.",
      "    Even more detail.",
      "- [ ] Next item"
    ].join("\n");

    const tasks = parseChecklist(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.description).toBe("More detail about building. Even more detail.");
    expect(tasks[1]?.description).toBeUndefined();
  });

  it("ignores non-checklist lines and returns [] when there are none", () => {
    expect(parseChecklist("just some text\n# heading\n")).toEqual([]);
    expect(parseChecklist("")).toEqual([]);
  });
});

describe("readGenericChecklist (AC004b)", () => {
  it("finds TODO.md when PLAN.md is absent", async () => {
    const project = await tempProject();
    await writeAt(project, "TODO.md", "- [ ] do a thing\n- [x] did a thing\n");

    const result = await readGenericChecklist(project);
    expect(result.source).toBe("TODO.md");
    expect(result.graph?.featureSlug).toBe("TODO.md");
    expect(result.graph?.tasks).toHaveLength(2);
  });

  it("warns about an empty PLAN.md and falls through to TODO.md", async () => {
    const project = await tempProject();
    await writeAt(project, "PLAN.md", "# Plan\n\nNo checklist items here.\n");
    await writeAt(project, "TODO.md", "- [ ] real task\n");

    const result = await readGenericChecklist(project);
    expect(result.source).toBe("TODO.md");
    expect(result.graph?.tasks).toHaveLength(1);
    expect(result.warnings).toContain("no checklist items found in PLAN.md");
  });

  it("returns null when no plan files exist", async () => {
    const project = await tempProject();
    const result = await readGenericChecklist(project);
    expect(result.graph).toBeNull();
    expect(result.source).toBeNull();
  });
});

describe("readSpecKit (AC004c)", () => {
  it("parses embedded task ids and strips them from titles", async () => {
    const project = await tempProject();
    await writeAt(
      project,
      "specs/001-foo/tasks.md",
      "- [ ] T001 Create schema\n- [x] T002 Wire it up\n"
    );

    const result = await readSpecKit(project);
    expect(result.source).toBe("spec-kit:001-foo/tasks.md");
    expect(result.graph?.featureSlug).toBe("001-foo");
    expect(result.graph?.tasks[0]?.id).toBe("T001");
    expect(result.graph?.tasks[0]?.title).toBe("Create schema");
    expect(result.graph?.tasks[1]?.id).toBe("T002");
    expect(result.graph?.tasks[1]?.dependsOn).toEqual(["T001"]);
  });

  it("picks the last sorted feature dir and warns about the rest", async () => {
    const project = await tempProject();
    await writeAt(project, "specs/001-foo/tasks.md", "- [ ] T001 Old\n");
    await writeAt(project, "specs/002-bar/tasks.md", "- [ ] T001 New\n");

    const result = await readSpecKit(project);
    expect(result.source).toBe("spec-kit:002-bar/tasks.md");
    expect(result.graph?.featureSlug).toBe("002-bar");
    expect(result.graph?.tasks[0]?.title).toBe("New");
    expect(result.warnings).toContain("ignored spec-kit:001-foo/tasks.md");
  });
});

describe("readOpenSpec (AC004d)", () => {
  it("parses openspec/changes/<dir>/tasks.md with an openspec source prefix", async () => {
    const project = await tempProject();
    await writeAt(
      project,
      "openspec/changes/add-auth/tasks.md",
      "- [ ] T001 Add login route\n- [ ] T002 Add session store\n"
    );

    const result = await readOpenSpec(project);
    expect(result.source).toBe("openspec:add-auth/tasks.md");
    expect(result.graph?.featureSlug).toBe("add-auth");
    expect(result.graph?.tasks).toHaveLength(2);
    expect(result.graph?.tasks[0]?.id).toBe("T001");
  });
});

describe("discoverPlanTaskGraph priority (AC005a)", () => {
  it("prefers the generic root checklist and warns about the ignored spec-kit source", async () => {
    const project = await tempProject();
    await writeAt(project, "tasks.md", "- [ ] root level task\n");
    await writeAt(project, "specs/001-foo/tasks.md", "- [ ] T001 spec task\n");

    const result = await discoverPlanTaskGraph(project);
    expect(result.source).toBe("tasks.md");
    expect(result.graph?.tasks[0]?.title).toBe("root level task");
    expect(result.warnings).toContain("ignored plan source: spec-kit:001-foo/tasks.md");
  });

  it("returns null when no plan source exists", async () => {
    const project = await tempProject();
    const result = await discoverPlanTaskGraph(project);
    expect(result.graph).toBeNull();
    expect(result.source).toBeNull();
  });
});

describe("loadTaskGraph fallback wiring (AC005b)", () => {
  it("returns the plan graph when there is no .visp kit but a PLAN.md", async () => {
    const project = await tempProject();
    await writeAt(project, "PLAN.md", "- [ ] from plan file\n");

    const graph = await loadTaskGraph(project);
    expect(graph).not.toBeNull();
    expect(graph?.tasks[0]?.title).toBe("from plan file");
  });

  it("prefers the real .visp kit graph over a PLAN.md when both exist", async () => {
    const project = await tempProject();
    const kitGraph = {
      featureId: "004",
      featureSlug: "kit-feature",
      tasks: [{ id: "T001", title: "kit task", dependsOn: [] }]
    };
    const dir = join(project, ".visp", "features", "004-kit");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "task-graph.json"), JSON.stringify(kitGraph, null, 2), "utf8");
    await writeAt(project, "PLAN.md", "- [ ] plan task\n");

    const graph = await loadTaskGraph(project);
    expect(graph?.featureId).toBe("004");
    expect(graph?.tasks[0]?.id).toBe("T001");
    expect(graph?.tasks[0]?.title).toBe("kit task");
  });

  it("returns null when neither a kit graph nor a plan file exists", async () => {
    const project = await tempProject();
    const graph = await loadTaskGraph(project);
    expect(graph).toBeNull();
  });
});
