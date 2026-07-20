import { createHash } from "node:crypto";
import { z } from "zod";
import { defaultConfig } from "../core/defaults.js";
import { readTextIfExists, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { resolveProjectFile } from "../core/project-path.js";
import type { SkillProposal } from "./skill-proposals.js";

export const skillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  originSessionId: z.string(),
  installedAtSessionCount: z.number().int().nonnegative(),
  destinations: z.array(z.string()),
  usedCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullable(),
  lastUsedSessionCount: z.number().int().nonnegative().nullable()
  ,source: z.string().optional()
  ,contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional()
  ,author: z.string().optional()
  ,approvedBy: z.string().nullable().optional()
  ,approvalExpiresAt: z.string().datetime().nullable().optional()
});

export const skillRegistrySchema = z.object({
  skills: z.array(skillEntrySchema)
});

export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type SkillRegistry = z.infer<typeof skillRegistrySchema>;

const registryRelativePath = ".visp/hyper/skills.json";

function emptyRegistry(): SkillRegistry {
  return { skills: [] };
}

/**
 * Read the skill registry. A missing file resolves to an empty registry with no
 * warnings; a corrupt or schema-invalid file resolves to an empty registry plus
 * a single warning so callers can surface it without failing.
 */
export async function readSkillRegistry(
  projectPath: string,
  options: { blockedPaths?: string[] } = {}
): Promise<{ registry: SkillRegistry; warnings: string[] }> {
  const path = await resolveRegistryPath(
    projectPath,
    options.blockedPaths ?? defaultConfig.blockedPaths
  );
  return readRegistryAtPath(path);
}

async function readRegistryAtPath(
  path: string
): Promise<{ registry: SkillRegistry; warnings: string[] }> {
  const raw = await readTextIfExists(path);
  const { value, warnings } = parseJsonStore(
    raw,
    skillRegistrySchema,
    emptyRegistry,
    "skills.json",
    "an empty registry"
  );
  return { registry: value, warnings };
}

export async function writeSkillRegistry(
  projectPath: string,
  registry: SkillRegistry,
  options: { blockedPaths?: string[] } = {}
): Promise<void> {
  const path = await resolveRegistryPath(
    projectPath,
    options.blockedPaths ?? defaultConfig.blockedPaths
  );
  await writeRegistryAtPath(path, registry);
}

async function resolveRegistryPath(projectPath: string, blockedPaths: string[]): Promise<string> {
  const path = await resolveProjectFile(projectPath, registryRelativePath, {
    mode: "write",
    blockedPaths
  });
  return path.absolutePath;
}

async function writeRegistryAtPath(path: string, registry: SkillRegistry): Promise<void> {
  await writeText(path, `${JSON.stringify(registry, null, 2)}\n`);
}

function normalizeDescription(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A proposal is a duplicate of a registered skill if it shares an exact name or
 * a normalized (lowercased, whitespace-collapsed, trimmed) description.
 */
export function isDuplicate(
  registry: SkillRegistry,
  proposal: { name: string; description: string }
): boolean {
  const normalized = normalizeDescription(proposal.description);
  return registry.skills.some(
    (skill) =>
      skill.name === proposal.name || normalizeDescription(skill.description) === normalized
  );
}

/**
 * Resolve the per-tool, namespaced installation path for a skill. Known tools
 * map to their native skill locations; anything else falls back to the
 * project's `.visp/hyper/skills/` directory.
 */
export function destinationFor(tool: string, name: string): string {
  switch (tool) {
    case "claude-code":
      return `.claude/skills/hyper-${name}/SKILL.md`;
    case "codex":
      return `.agents/skills/hyper-${name}/SKILL.md`;
    case "copilot":
      return `.github/instructions/hyper-${name}.instructions.md`;
    default:
      return `.visp/hyper/skills/hyper-${name}.md`;
  }
}

function renderSkill(proposal: SkillProposal): string {
  return [
    "---",
    `name: hyper-${proposal.name}`,
    `description: ${proposal.description}`,
    `when_to_use: ${proposal.whenToUse}`,
    "---",
    "",
    proposal.body,
    ""
  ].join("\n");
}

function proposalHash(proposal: SkillProposal): string {
  return createHash("sha256")
    .update(JSON.stringify({
      name: proposal.name,
      description: proposal.description,
      whenToUse: proposal.whenToUse,
      body: proposal.body
    }))
    .digest("hex");
}


/**
 * Install a skill to its tool-specific destination and register it. If the
 * destination file already exists, the install is skipped (no write, no
 * registry change) and a warning is returned. Otherwise the rendered `SKILL.md`
 * is written and a registry entry is appended.
 */
export async function installSkill(
  projectPath: string,
  proposal: SkillProposal,
  input: { tool: string; sessionId: string; sessionCount: number; blockedPaths?: string[] }
): Promise<{ installed: boolean; destination: string; warning?: string }> {
  const destination = destinationFor(input.tool, proposal.name);
  const blockedPaths = input.blockedPaths ?? defaultConfig.blockedPaths;
  const destinationPath = await resolveProjectFile(projectPath, destination, {
    mode: "write",
    blockedPaths
  });

  if (destinationPath.exists) {
    return {
      installed: false,
      destination,
      warning: `skill destination already exists; skipped install of hyper-${proposal.name} at ${destination}.`
    };
  }

  // Resolve and load the registry before writing the skill so every managed
  // destination is fixed before the first write begins.
  const registryPath = await resolveRegistryPath(projectPath, blockedPaths);
  const destinationKey = canonicalKey(destinationPath.absolutePath);
  if (destinationKey === canonicalKey(registryPath)) {
    throw new Error(`Refused alias collision between ${destination} and ${registryRelativePath}.`);
  }
  const { registry } = await readRegistryAtPath(registryPath);
  await writeText(destinationPath.absolutePath, renderSkill(proposal));
  registry.skills.push({
    name: proposal.name,
    description: proposal.description,
    whenToUse: proposal.whenToUse,
    originSessionId: input.sessionId,
    installedAtSessionCount: input.sessionCount,
    destinations: [destination],
    usedCount: 0,
    lastUsedAt: null,
    lastUsedSessionCount: null,
    source: proposal.sourcePath,
    contentHash: proposalHash(proposal),
    author: "agent-proposal",
    approvedBy: null,
    approvalExpiresAt: null
  });
  await writeRegistryAtPath(registryPath, registry);

  return { installed: true, destination };
}

function canonicalKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Record a usage of an installed skill. Returns `false` without writing when the
 * skill name is unknown; otherwise increments the usage counter and updates the
 * last-used timestamp and session count.
 */
export async function recordUsage(
  projectPath: string,
  name: string,
  input: { sessionCount: number }
): Promise<boolean> {
  const { registry } = await readSkillRegistry(projectPath);
  const skill = registry.skills.find((entry) => entry.name === name);
  if (!skill) {
    return false;
  }

  skill.usedCount += 1;
  skill.lastUsedAt = new Date().toISOString();
  skill.lastUsedSessionCount = input.sessionCount;
  await writeSkillRegistry(projectPath, registry);
  return true;
}
