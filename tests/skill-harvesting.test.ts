import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { defaultConfig } from "../src/core/defaults.js";
import { initializeProject, readConfig } from "../src/core/session-manager.js";
import {
  INCOMING_DIR,
  REJECTED_DIR,
  STAGED_DIR,
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
import { startMockMemoryServer, type MockMemoryServer } from "./helpers/mock-memory-server.js";

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

    it("rejects traversal in a direct proposal before writing a skill or registry", async () => {
      const project = await makeProject();

      await expect(
        installSkill(project, proposal({ name: "x/../../../../escape" }), {
          tool: "codex",
          sessionId: "vh_session",
          sessionCount: 1
        })
      ).rejects.toThrow(/parent traversal/);

      expect(await exists(join(project, ".agents"))).toBe(false);
      expect(await exists(join(project, ".visp", "hyper", "skills.json"))).toBe(false);
    });

    it("rejects an escaping skill destination without writing outside", async () => {
      const project = await makeProject();
      const outside = await mkdtemp(join(tmpdir(), "visp-skill-outside-"));
      await symlink(outside, join(project, ".agents"), "dir");

      await expect(
        installSkill(project, proposal(), {
          tool: "codex",
          sessionId: "vh_session",
          sessionCount: 1
        })
      ).rejects.toThrow(/resolved path escapes/);

      expect(await readdir(outside)).toEqual([]);
      expect(await exists(join(project, ".visp", "hyper", "skills.json"))).toBe(false);
    });

    it("preflights an escaping registry before writing the skill", async () => {
      const project = await makeProject();
      const outside = await mkdtemp(join(tmpdir(), "visp-registry-outside-"));
      await symlink(outside, join(project, ".visp"), "dir");

      await expect(
        installSkill(project, proposal(), {
          tool: "codex",
          sessionId: "vh_session",
          sessionCount: 1
        })
      ).rejects.toThrow(/resolved path escapes/);

      expect(
        await exists(join(project, ".agents", "skills", "hyper-deploy-dance", "SKILL.md"))
      ).toBe(false);
      expect(await readdir(outside)).toEqual([]);
    });

    it("allows a skill destination through an in-project parent symlink", async () => {
      const project = await makeProject();
      const target = join(project, "internal", "agents");
      await mkdir(target, { recursive: true });
      await symlink(target, join(project, ".agents"), "dir");

      const result = await installSkill(project, proposal(), {
        tool: "codex",
        sessionId: "vh_session",
        sessionCount: 1
      });

      expect(result.installed).toBe(true);
      expect(await exists(join(target, "skills", "hyper-deploy-dance", "SKILL.md"))).toBe(true);
      expect((await readSkillRegistry(project)).registry.skills).toHaveLength(1);
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
  it("parses a legacy config without skillMode and defaults to review", async () => {
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
    expect(config.skillMode).toBe("review");
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

  it("defaults to skillMode review", () => {
    expect(defaultConfig.skillMode).toBe("review");
  });
});

let server: MockMemoryServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (server) {
    await server.close();
    server = undefined;
  }
});

const baseConfig = {
  defaultTool: "generic",
  tokenBudget: 12000,
  contextMode: "deterministic",
  blockedPaths: [".git"]
};

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-skill-int-"));
  await writeFile(join(projectPath, "README.md"), "# Demo\n", "utf8");
  await writeFile(join(projectPath, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await initializeProject(projectPath);
  return projectPath;
}

async function writeConfig(projectPath: string, config: Record<string, unknown>): Promise<void> {
  await initializeProject(projectPath);
  await writeFile(
    join(projectPath, ".visp", "hyper", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
}

async function dropProposal(projectPath: string, fileName: string, content: string): Promise<void> {
  const incoming = join(projectPath, INCOMING_DIR);
  await mkdir(incoming, { recursive: true });
  await writeFile(join(incoming, fileName), content, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function captureLogs(): string[] {
  const logs: string[] = [];
  const collect = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(collect);
  vi.spyOn(console, "warn").mockImplementation(collect);
  return logs;
}

describe("skill harvesting integration", () => {
  it("AC003a: auto mode installs a proposal, removes the incoming file, and registers it", async () => {
    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);

    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());

    const logs = captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    expect(await exists(join(projectPath, ".claude", "skills", "hyper-deploy-dance", "SKILL.md"))).toBe(true);
    expect(await exists(join(projectPath, INCOMING_DIR, "deploy-dance.md"))).toBe(false);

    const { registry } = await readSkillRegistry(projectPath);
    expect(registry.skills.map((s) => s.name)).toContain("deploy-dance");
    expect(logs.some((l) => l.includes("skill installed: deploy-dance -> .claude/skills/hyper-deploy-dance/SKILL.md"))).toBe(
      true
    );
  });

  it("AC003b: review mode stages the proposal and does not install it", async () => {
    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "review" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);

    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());

    const logs = captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    expect(await exists(join(projectPath, STAGED_DIR, "deploy-dance.md"))).toBe(true);
    expect(await exists(join(projectPath, ".claude", "skills", "hyper-deploy-dance", "SKILL.md"))).toBe(false);
    const { registry } = await readSkillRegistry(projectPath);
    expect(registry.skills).toHaveLength(0);
    expect(logs.some((l) => l.includes("skill staged for review: deploy-dance"))).toBe(true);
  });

  it("AC003c: an invalid proposal is rejected with an error comment", async () => {
    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);

    await dropProposal(projectPath, "bad.md", "no frontmatter here");

    const logs = captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    const rejected = join(projectPath, REJECTED_DIR, "bad.md");
    expect(await exists(rejected)).toBe(true);
    const content = await readFile(rejected, "utf8");
    expect(content).toContain("<!-- rejected: missing frontmatter fence -->");
    expect(logs.some((l) => l.includes("skill rejected: bad.md (missing frontmatter fence)"))).toBe(true);
  });

  it("AC004a: a subsequent start prints the installed skill in project_skills", async () => {
    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);
    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    const logs = captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "again", "--tool", "claude-code"]);
    const text = logs.join("\n");
    expect(text).toContain("project_skills:");
    expect(text).toContain("hyper-deploy-dance");
    expect(text).toContain("skill_protocol:");
  });

  it("AC004b: --used-skill records usage and warns on unknown names", async () => {
    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);
    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    const logs = captureLogs();
    await runCli([
      "node",
      "visp-hyper",
      "--project",
      projectPath,
      "remember",
      "--summary",
      "again",
      "--used-skill",
      "deploy-dance",
      "--used-skill",
      "missing-skill"
    ]);

    const { registry } = await readSkillRegistry(projectPath);
    expect(registry.skills.find((s) => s.name === "deploy-dance")?.usedCount).toBe(1);
    expect(logs.some((l) => l.includes("warning: unknown skill: missing-skill"))).toBe(true);
  });

  it("AC005: report flags a stale skill as a prune candidate", async () => {
    const projectPath = await createProject();

    const registry: SkillRegistry = {
      skills: [
        {
          name: "deploy-dance",
          description: "Deploy the stack.",
          whenToUse: "When deploying.",
          originSessionId: "vh_seed",
          installedAtSessionCount: 1,
          destinations: [".claude/skills/hyper-deploy-dance/SKILL.md"],
          usedCount: 0,
          lastUsedAt: null,
          lastUsedSessionCount: null
        }
      ]
    };
    await writeSkillRegistry(projectPath, registry);

    const sessions: Record<string, unknown> = {};
    for (let i = 0; i < 7; i += 1) {
      sessions[`vh_${i}`] = {
        id: `vh_${i}`,
        goal: "g",
        tool: "generic",
        projectPath,
        createdAt: "2026-06-11T00:00:00.000Z",
        updatedAt: "2026-06-11T00:00:00.000Z",
        phase: "implementation",
        relevantFiles: []
      };
    }
    await writeFile(
      join(projectPath, ".visp", "hyper", "state.json"),
      `${JSON.stringify({ activeSessionId: null, sessions }, null, 2)}\n`,
      "utf8"
    );

    const logs = captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "report"]);
    const text = logs.join("\n");
    expect(text).toContain("hyper-deploy-dance: used=0 last_used=never [PRUNE CANDIDATE]");

    logs.length = 0;
    await runCli(["node", "visp-hyper", "--project", projectPath, "report", "--json"]);
    const parsed = JSON.parse(logs.join("\n"));
    const skill = parsed.skills.find((s: { name: string }) => s.name === "deploy-dance");
    expect(skill.pruneCandidate).toBe(true);
  });

  it("AC006: installed skills mirror to the memory server as semantic patterns", async () => {
    const projectPath = await createProject();
    server = await startMockMemoryServer({
      "GET /healthz": { json: { status: "ok" } },
      "POST /recall": { json: [] },
      "POST /memories": { json: { id: "saved", content: "x", layer: "semantic", category: "pattern" } }
    });
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "llm-memory", memoryEndpoint: server.url, skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);

    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());
    await runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"]);

    const pattern = server.requests.find(
      (r) => r.path === "/memories" && (r.body as { category?: string }).category === "pattern"
    );
    expect(pattern?.method).toBe("POST");
    expect(pattern?.body).toMatchObject({ layer: "semantic", category: "pattern" });
    expect((pattern?.body as { content: string }).content).toContain("hyper-deploy-dance");
  });

  it("AC006: a closed memory endpoint still installs the skill and exits zero", async () => {
    const closed = await startMockMemoryServer({});
    const url = closed.url;
    await closed.close();

    const projectPath = await createProject();
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "file", skillMode: "auto" });
    captureLogs();
    await runCli(["node", "visp-hyper", "--project", projectPath, "start", "ship it", "--tool", "claude-code"]);
    await writeConfig(projectPath, { ...baseConfig, memoryMode: "llm-memory", memoryEndpoint: url, skillMode: "auto" });

    await dropProposal(projectPath, "deploy-dance.md", validProposalFile());

    captureLogs();
    await expect(
      runCli(["node", "visp-hyper", "--project", projectPath, "remember", "--summary", "done"])
    ).resolves.toBeUndefined();

    expect(await exists(join(projectPath, ".claude", "skills", "hyper-deploy-dance", "SKILL.md"))).toBe(true);
  });
});
