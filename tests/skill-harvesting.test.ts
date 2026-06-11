import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/defaults.js";
import { readConfig } from "../src/core/session-manager.js";
import {
  INCOMING_DIR,
  REJECTED_DIR,
  moveToRejected,
  parseProposal,
  scanIncoming
} from "../src/skills/skill-proposals.js";
import type { SkillProposal } from "../src/skills/skill-proposals.js";
import {
  destinationFor,
  installSkill,
  isDuplicate,
  readSkillRegistry,
  recordUsage,
  writeSkillRegistry
} from "../src/skills/skill-registry.js";
import type { SkillRegistry } from "../src/skills/skill-registry.js";

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "visp-skill-"));
}

function validProposalFile(overrides: Partial<Record<string, string>> = {}): string {
  const name = overrides.name ?? "deploy-dance";
  const description = overrides.description ?? "One-line summary.";
  const whenToUse = overrides.whenToUse ?? "When deploying the staging stack.";
  const evidence = overrides.evidence ?? "Used twice this session for X and Y.";
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `when_to_use: ${whenToUse}`,
    `evidence: ${evidence}`,
    "---",
    "Step 1: do the thing.",
    "Step 2: do the other thing."
  ].join("\n");
}

describe("skill-proposals", () => {
  describe("AC001a parseProposal happy path", () => {
    it("parses all fields and the body, ignoring unknown frontmatter keys", () => {
      const content = [
        "---",
        "name: deploy-dance",
        "description: One-line summary.",
        "when_to_use: When deploying the staging stack.",
        "evidence: Used twice this session for X and Y.",
        "unknown_key: should be ignored",
        "---",
        "Step 1: do the thing.",
        "",
        "Step 2: do the other thing."
      ].join("\n");

      const result = parseProposal(content, "/incoming/deploy-dance.md");
      expect("proposal" in result).toBe(true);
      if (!("proposal" in result)) return;
      const p = result.proposal;
      expect(p.name).toBe("deploy-dance");
      expect(p.description).toBe("One-line summary.");
      expect(p.whenToUse).toBe("When deploying the staging stack.");
      expect(p.evidence).toBe("Used twice this session for X and Y.");
      expect(p.body).toBe("Step 1: do the thing.\n\nStep 2: do the other thing.");
      expect(p.sourcePath).toBe("/incoming/deploy-dance.md");
      expect("unknown_key" in (p as Record<string, unknown>)).toBe(false);
    });
  });

  describe("AC001b parseProposal failure modes", () => {
    const expectError = (content: string, message: string) => {
      const result = parseProposal(content, "/incoming/x.md");
      expect("error" in result).toBe(true);
      if ("error" in result) expect(result.error).toBe(message);
    };

    it("missing fences", () => {
      expectError("name: deploy-dance\nno fences here", "missing frontmatter fence");
    });

    it("missing closing fence", () => {
      expectError("---\nname: deploy-dance\nbody but no close", "missing frontmatter fence");
    });

    it("non-kebab name", () => {
      expectError(validProposalFile({ name: "Deploy_Dance" }), "name must be kebab-case");
    });

    it("missing description", () => {
      expectError(validProposalFile({ description: "" }), "description is required");
    });

    it("missing when_to_use", () => {
      expectError(validProposalFile({ whenToUse: "" }), "when_to_use is required");
    });

    it("empty body", () => {
      const content = [
        "---",
        "name: deploy-dance",
        "description: One-line summary.",
        "when_to_use: When deploying.",
        "---",
        "",
        "   "
      ].join("\n");
      expectError(content, "body must be non-empty");
    });
  });

  describe("AC001c scanIncoming + moveToRejected", () => {
    it("splits valid and invalid files; missing dir yields empty", async () => {
      const project = await makeProject();
      expect(await scanIncoming(project)).toEqual({ valid: [], invalid: [] });

      const incoming = join(project, INCOMING_DIR);
      await mkdir(incoming, { recursive: true });
      await writeFile(join(incoming, "a.md"), validProposalFile({ name: "skill-a" }), "utf8");
      await writeFile(join(incoming, "b.md"), validProposalFile({ name: "skill-b" }), "utf8");
      await writeFile(join(incoming, "c.md"), "no frontmatter here", "utf8");

      const result = await scanIncoming(project);
      expect(result.valid.map((p) => p.name).sort()).toEqual(["skill-a", "skill-b"]);
      expect(result.invalid).toHaveLength(1);
      expect(result.invalid[0]?.error).toBe("missing frontmatter fence");
    });

    it("moveToRejected moves the file and appends the error comment", async () => {
      const project = await makeProject();
      const incoming = join(project, INCOMING_DIR);
      await mkdir(incoming, { recursive: true });
      const source = join(incoming, "bad.md");
      await writeFile(source, "bad content", "utf8");

      await moveToRejected(project, source, "missing frontmatter fence");

      const rejected = join(project, REJECTED_DIR, "bad.md");
      const content = await readFile(rejected, "utf8");
      expect(content).toContain("bad content");
      expect(content).toContain("<!-- rejected: missing frontmatter fence -->");

      const remaining = await readdir(incoming);
      expect(remaining).not.toContain("bad.md");
    });
  });
});

function proposal(overrides: Partial<SkillProposal> = {}): SkillProposal {
  return {
    name: "deploy-dance",
    description: "Deploy the stack.",
    whenToUse: "When deploying.",
    body: "Step 1.",
    sourcePath: "/incoming/deploy-dance.md",
    ...overrides
  };
}

describe("skill-registry", () => {
  describe("AC002a isDuplicate", () => {
    const registry: SkillRegistry = {
      skills: [
        {
          name: "deploy-dance",
          description: "Deploy the stack",
          whenToUse: "When deploying.",
          originSessionId: "vh_x",
          installedAtSessionCount: 1,
          destinations: [".claude/skills/hyper-deploy-dance/SKILL.md"],
          usedCount: 0,
          lastUsedAt: null,
          lastUsedSessionCount: null
        }
      ]
    };

    it("matches an exact name", () => {
      expect(isDuplicate(registry, { name: "deploy-dance", description: "totally different" })).toBe(
        true
      );
    });

    it("matches a normalized description", () => {
      expect(
        isDuplicate(registry, { name: "other-name", description: "  Deploy   THE stack " })
      ).toBe(true);
    });

    it("passes a non-duplicate", () => {
      expect(isDuplicate(registry, { name: "fresh-skill", description: "Something else" })).toBe(
        false
      );
    });
  });

  describe("AC002b installSkill + destinationFor", () => {
    it("maps destinations for all four tool groups", () => {
      expect(destinationFor("claude-code", "deploy-dance")).toBe(
        ".claude/skills/hyper-deploy-dance/SKILL.md"
      );
      expect(destinationFor("codex", "deploy-dance")).toBe(
        ".agents/skills/hyper-deploy-dance/SKILL.md"
      );
      expect(destinationFor("copilot", "deploy-dance")).toBe(
        ".github/instructions/hyper-deploy-dance.instructions.md"
      );
      expect(destinationFor("generic", "deploy-dance")).toBe(
        ".visp/hyper/skills/hyper-deploy-dance.md"
      );
    });

    it("writes the claude-code destination with rendered content and registers", async () => {
      const project = await makeProject();
      const result = await installSkill(project, proposal(), {
        tool: "claude-code",
        sessionId: "vh_session",
        sessionCount: 3
      });

      expect(result.installed).toBe(true);
      expect(result.destination).toBe(".claude/skills/hyper-deploy-dance/SKILL.md");

      const written = await readFile(join(project, result.destination), "utf8");
      expect(written).toContain("name: hyper-deploy-dance");
      expect(written).toContain("description: Deploy the stack.");
      expect(written).toContain("when_to_use: When deploying.");
      expect(written).toContain("Step 1.");

      const { registry } = await readSkillRegistry(project);
      expect(registry.skills).toHaveLength(1);
      const entry = registry.skills[0];
      expect(entry?.name).toBe("deploy-dance");
      expect(entry?.originSessionId).toBe("vh_session");
      expect(entry?.installedAtSessionCount).toBe(3);
      expect(entry?.destinations).toEqual([".claude/skills/hyper-deploy-dance/SKILL.md"]);
      expect(entry?.usedCount).toBe(0);
      expect(entry?.lastUsedAt).toBeNull();
    });

    it("skips a second install to an existing file and leaves the registry unchanged", async () => {
      const project = await makeProject();
      const input = { tool: "claude-code", sessionId: "vh_session", sessionCount: 1 };
      await installSkill(project, proposal(), input);

      const before = await readSkillRegistry(project);
      const second = await installSkill(project, proposal(), input);

      expect(second.installed).toBe(false);
      expect(second.warning).toBeDefined();

      const after = await readSkillRegistry(project);
      expect(after.registry).toEqual(before.registry);
      expect(after.registry.skills).toHaveLength(1);
    });
  });

  describe("AC002c registry read + recordUsage", () => {
    it("returns an empty registry plus a warning for corrupt skills.json", async () => {
      const project = await makeProject();
      await mkdir(join(project, ".visp", "hyper"), { recursive: true });
      await writeFile(join(project, ".visp", "hyper", "skills.json"), "{not json", "utf8");

      const { registry, warnings } = await readSkillRegistry(project);
      expect(registry.skills).toEqual([]);
      expect(warnings).toHaveLength(1);
    });

    it("recordUsage returns false for an unknown skill", async () => {
      const project = await makeProject();
      await writeSkillRegistry(project, { skills: [] });
      expect(await recordUsage(project, "nope", { sessionCount: 2 })).toBe(false);
    });

    it("recordUsage updates counters for a known skill", async () => {
      const project = await makeProject();
      await installSkill(project, proposal(), {
        tool: "claude-code",
        sessionId: "vh_session",
        sessionCount: 1
      });

      expect(await recordUsage(project, "deploy-dance", { sessionCount: 5 })).toBe(true);

      const { registry } = await readSkillRegistry(project);
      const entry = registry.skills[0];
      expect(entry?.usedCount).toBe(1);
      expect(entry?.lastUsedSessionCount).toBe(5);
      expect(typeof entry?.lastUsedAt).toBe("string");
    });
  });
});

describe("skillMode config lockstep", () => {
  it("parses a legacy config without skillMode and defaults to auto", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-skill-cfg-"));
    const hyperDir = join(dir, ".visp", "hyper");
    await mkdir(hyperDir, { recursive: true });
    await writeFile(
      join(hyperDir, "config.json"),
      JSON.stringify({
        defaultTool: "generic",
        tokenBudget: 12000,
        memoryMode: "file",
        memoryEndpoint: "http://localhost:8000",
        contextMode: "deterministic",
        blockedPaths: []
      }),
      "utf8"
    );

    const config = await readConfig(dir);
    expect(config.skillMode).toBe("auto");
  });

  it("accepts an explicit review mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-skill-cfg-"));
    const hyperDir = join(dir, ".visp", "hyper");
    await mkdir(hyperDir, { recursive: true });
    await writeFile(
      join(hyperDir, "config.json"),
      JSON.stringify({ ...defaultConfig, skillMode: "review" }),
      "utf8"
    );

    const config = await readConfig(dir);
    expect(config.skillMode).toBe("review");
  });

  it("defaults to skillMode auto", () => {
    expect(defaultConfig.skillMode).toBe("auto");
  });
});
