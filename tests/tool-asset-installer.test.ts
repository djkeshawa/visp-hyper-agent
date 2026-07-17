import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installAssets,
  isKitOwnedDestination,
  planInstall
} from "../src/install/tool-asset-installer.js";

// The real repo templates, resolved relative to the project root (vitest cwd).
const REAL_TEMPLATES = join(process.cwd(), "templates");

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vh-install-"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("planInstall / installAssets (AC001)", () => {
  it("plans agents+commands for claude-code and installs them with rendered models", async () => {
    const project = await makeProject();

    const plan = await planInstall("claude-code", project, { templatesDir: REAL_TEMPLATES });
    const destinations = plan.map((p) => p.destination);
    expect(destinations).toContain(".claude/agents/coordinator.md");
    expect(destinations).toContain(".claude/agents/scout.md");
    expect(destinations).toContain(".claude/agents/implementer.md");
    expect(destinations).toContain(".claude/commands/hyper-run.md");
    expect(destinations).toContain(".claude/commands/hyper-remember.md");
    // model-map.json is data, never planned for install.
    expect(destinations.some((d) => d.includes("model-map.json"))).toBe(false);
    expect(plan.every((p) => p.exists === false)).toBe(true);

    const report = await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });
    expect(report.created).toEqual(expect.arrayContaining(destinations));
    expect(report.skipped).toEqual([]);
    expect(report.overwritten).toEqual([]);

    const coordinator = await readFile(join(project, ".claude/agents/coordinator.md"), "utf8");
    const scout = await readFile(join(project, ".claude/agents/scout.md"), "utf8");
    const implementer = await readFile(join(project, ".claude/agents/implementer.md"), "utf8");
    expect(coordinator).toContain("model: inherit");
    expect(scout).toContain("model: sonnet");
    expect(implementer).toContain("model: opus");
    // No tokens left unrendered.
    for (const body of [coordinator, scout, implementer]) {
      expect(body).not.toContain("{{");
    }
  });
});

describe("non-claude installs (AC001b)", () => {
  it("writes codex destinations", async () => {
    const project = await makeProject();
    const report = await installAssets("codex", project, { templatesDir: REAL_TEMPLATES });
    expect(report.created).toEqual(
      expect.arrayContaining(["AGENTS.visp-hyper.md", ".agents/skills/visp-hyper/SKILL.md"])
    );
    expect(await pathExists(join(project, "AGENTS.visp-hyper.md"))).toBe(true);
    expect(await pathExists(join(project, ".agents/skills/visp-hyper/SKILL.md"))).toBe(true);
  });

  it("writes copilot destination", async () => {
    const project = await makeProject();
    const report = await installAssets("copilot", project, { templatesDir: REAL_TEMPLATES });
    expect(report.created).toEqual([".github/instructions/visp-hyper.instructions.md"]);
    expect(await pathExists(join(project, ".github/instructions/visp-hyper.instructions.md"))).toBe(true);
  });

  it("writes generic destination", async () => {
    const project = await makeProject();
    const report = await installAssets("generic", project, { templatesDir: REAL_TEMPLATES });
    expect(report.created).toEqual(["visp-hyper-instructions.md"]);
    const body = await readFile(join(project, "visp-hyper-instructions.md"), "utf8");
    // Non-claude templates carry no model tokens, so nothing is left dangling.
    expect(body).not.toContain("{{");
  });

  it("writes opencode destination", async () => {
    const project = await makeProject();
    const report = await installAssets("opencode", project, { templatesDir: REAL_TEMPLATES });
    expect(report.created).toEqual(["visp-hyper-instructions.md"]);
    expect(await pathExists(join(project, "visp-hyper-instructions.md"))).toBe(true);
  });
});

describe("installed workflow authority wording", () => {
  const localEvidence = "Hyper checkpoint results are local evidence only.";
  const kitAuthority = "Strict progression and remediation require the exact current ready Kit action.";
  const remembrance = "Remember records session learnings and does not complete a Kit task.";

  it.each([
    ["generic", ["visp-hyper-instructions.md"]],
    ["opencode", ["visp-hyper-instructions.md"]],
    ["copilot", [".github/instructions/visp-hyper.instructions.md"]],
    ["codex", ["AGENTS.visp-hyper.md", ".agents/skills/visp-hyper/SKILL.md"]],
    ["claude-code", [".claude/agents/coordinator.md", ".claude/commands/hyper-run.md"]]
  ] as const)("keeps %s installed guidance mode-neutral", async (tool, paths) => {
    const project = await makeProject();
    await installAssets(tool, project, { templatesDir: REAL_TEMPLATES });

    for (const path of paths) {
      const body = await readFile(join(project, path), "utf8");
      expect(body).toContain(localEvidence);
      expect(body).toContain(kitAuthority);
      expect(body).toContain(remembrance);
      expect(body).not.toMatch(/On PASSED,?\s+proceed/iu);
      expect(body).not.toMatch(/Advance (between tasks |only )?(with|through) `visp-hyper checkpoint/iu);
    }
  });

  it("keeps the remaining Claude commands from granting strict progress or remediation", async () => {
    const project = await makeProject();
    await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });

    for (const path of [
      ".claude/commands/hyper-next.md",
      ".claude/commands/hyper-checkpoint.md",
      ".claude/commands/hyper-fanout.md"
    ]) {
      const body = await readFile(join(project, path), "utf8");
      expect(body).toContain(localEvidence);
      expect(body).toContain(kitAuthority);
      expect(body).not.toMatch(/proceed only on PASSED/iu);
      expect(body).not.toMatch(/On a FAILED result, fix/iu);
      expect(body).not.toMatch(/until every earlier task reports PASSED/iu);
    }
  });

  it("keeps Claude review advisory and remembrance separate from Kit completion", async () => {
    const project = await makeProject();
    await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });

    const review = await readFile(join(project, ".claude/commands/hyper-review.md"), "utf8");
    expect(review).toContain("Hyper review warnings are local evidence only.");
    expect(review).toContain(kitAuthority);
    expect(review).not.toMatch(/address each warning it reports/iu);

    const remember = await readFile(join(project, ".claude/commands/hyper-remember.md"), "utf8");
    expect(remember).toContain(remembrance);
  });
});

describe("non-clobbering install (AC002)", () => {
  it("skips all on re-run without force and overwrites with force", async () => {
    const project = await makeProject();
    await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });

    const dest = join(project, ".claude/agents/coordinator.md");
    const original = await readFile(dest, "utf8");

    const rerun = await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });
    expect(rerun.created).toEqual([]);
    expect(rerun.skipped.length).toBeGreaterThan(0);
    expect(rerun.warnings.length).toBeGreaterThan(0);
    // File content unchanged after the skipped re-run.
    expect(await readFile(dest, "utf8")).toBe(original);

    const forced = await installAssets("claude-code", project, {
      templatesDir: REAL_TEMPLATES,
      force: true
    });
    expect(forced.skipped).toEqual([]);
    expect(forced.overwritten).toEqual(expect.arrayContaining([".claude/agents/coordinator.md"]));
  });

  it("AC002b: preserves a pre-existing hand-written file and warns", async () => {
    const project = await makeProject();
    const dest = join(project, ".claude/agents/coordinator.md");
    await mkdir(join(project, ".claude/agents"), { recursive: true });
    await writeFile(dest, "MY HAND-WRITTEN COORDINATOR", "utf8");

    const report = await installAssets("claude-code", project, { templatesDir: REAL_TEMPLATES });
    expect(report.skipped).toContain(".claude/agents/coordinator.md");
    expect(report.warnings.some((w) => w.includes("coordinator.md"))).toBe(true);
    expect(await readFile(dest, "utf8")).toBe("MY HAND-WRITTEN COORDINATOR");
  });
});

describe("kit-owned denylist (AC003)", () => {
  it("flags denylisted destinations and clears safe ones", () => {
    expect(isKitOwnedDestination("AGENTS.md")).toBe(true);
    expect(isKitOwnedDestination("./AGENTS.md")).toBe(true);
    expect(isKitOwnedDestination(".claude/commands/visp-foo.md")).toBe(true);
    expect(isKitOwnedDestination(".github/copilot-instructions.md")).toBe(true);
    expect(isKitOwnedDestination(".claude/commands/hyper-run.md")).toBe(false);
    expect(isKitOwnedDestination(".claude/agents/coordinator.md")).toBe(false);
    expect(isKitOwnedDestination("visp-hyper-instructions.md")).toBe(false);
  });

  it("denies the broadened kit-owned destinations", () => {
    expect(isKitOwnedDestination("AGENTS.visp.md")).toBe(true);
    expect(isKitOwnedDestination(".agents/skills/visp-core/SKILL.md")).toBe(true);
    expect(isKitOwnedDestination(".agents/skills/visp-foo/anything.md")).toBe(true);
    expect(isKitOwnedDestination(".github/instructions/visp-core.instructions.md")).toBe(true);
    expect(isKitOwnedDestination(".visp/prompts/visp-rules.md")).toBe(true);
    expect(isKitOwnedDestination(".visp/hooks/pre-commit")).toBe(true);
    expect(isKitOwnedDestination(".visp/hooks")).toBe(true);
    // Backslash form is normalized before matching.
    expect(isKitOwnedDestination(".agents\\skills\\visp-core\\SKILL.md")).toBe(true);
  });

  it("still allows hyper's OWN manifest destinations (must not be denied)", () => {
    expect(isKitOwnedDestination("AGENTS.visp-hyper.md")).toBe(false);
    expect(isKitOwnedDestination(".agents/skills/visp-hyper/SKILL.md")).toBe(false);
    expect(isKitOwnedDestination(".github/instructions/visp-hyper.instructions.md")).toBe(false);
  });

  it("every hyper MANIFEST destination is allowed and appears in planInstall", async () => {
    const project = await makeProject();
    for (const tool of ["claude-code", "codex", "copilot", "generic", "opencode"] as const) {
      const plan = await planInstall(tool, project, { templatesDir: REAL_TEMPLATES });
      // No planned destination is kit-owned.
      for (const asset of plan) {
        expect(isKitOwnedDestination(asset.destination)).toBe(false);
      }
      // planInstall and installAssets agree: the plan's destinations are exactly
      // what a fresh install creates.
      const report = await installAssets(tool, await makeProject(), { templatesDir: REAL_TEMPLATES });
      expect(report.created.sort()).toEqual(plan.map((p) => p.destination).sort());
      expect(report.warnings.some((w) => w.includes("kit-owned"))).toBe(false);
    }
  });
});

describe("missing templates (errors)", () => {
  it("planInstall throws a clear message when the templates dir is missing", async () => {
    const project = await makeProject();
    const missing = join(tmpdir(), "vh-no-templates-xyz");
    await expect(planInstall("claude-code", project, { templatesDir: missing })).rejects.toThrow(
      /Templates directory not found/
    );
  });

  it("installAssets throws before any write when the tool subdir is missing", async () => {
    const project = await makeProject();
    const onlyRoot = await mkdtemp(join(tmpdir(), "vh-empty-templates-"));
    await expect(
      installAssets("claude-code", project, { templatesDir: onlyRoot })
    ).rejects.toThrow(/Templates for tool "claude-code" not found/);
  });
});
