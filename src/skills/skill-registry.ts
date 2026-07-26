import { z } from "zod";
import { fileExists, readTextIfExists, vispPath, writeText } from "../core/fs-utils.js";
import { parseJsonStore } from "../core/json-store.js";
import { withStoreLock } from "../core/store-lock.js";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  lastUsedSessionCount: z.number().int().nonnegative().nullable(),
  source: z.string().optional(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  author: z.string().optional(),
  approvedBy: z.string().nullable().optional(),
  approvalExpiresAt: z.string().datetime().nullable().optional()
});

export const skillRegistrySchema = z.object({
  skills: z.array(skillEntrySchema)
});

export type SkillEntry = z.infer<typeof skillEntrySchema>;
export type SkillRegistry = z.infer<typeof skillRegistrySchema>;

function registryPath(projectPath: string): string {
  return vispPath(projectPath, "hyper", "skills.json");
}

function emptyRegistry(): SkillRegistry {
  return { skills: [] };
}

/**
 * Read the skill registry. A missing file resolves to an empty registry with no
 * warnings; a corrupt or schema-invalid file resolves to an empty registry plus
 * a single warning so callers can surface it without failing.
 */
export async function readSkillRegistry(
  projectPath: string
): Promise<{ registry: SkillRegistry; warnings: string[] }> {
  const raw = await readTextIfExists(registryPath(projectPath));
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
  registry: SkillRegistry
): Promise<void> {
  await writeText(registryPath(projectPath), `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * Locked read-modify-write over the skill registry, so concurrent visp-hyper
 * invocations (fan-out subagents, MCP calls, a checkpoint harvesting while a
 * remember records usage) cannot drop each other's updates. Mirrors
 * `updateRoutingState`. Every mutation of `skills.json` must go through here:
 * an unlocked read-then-write silently loses entries, and `report` prunes
 * skills by `usedCount`, so a lost increment can retire a skill still in use.
 */
export async function updateSkillRegistry<T>(
  projectPath: string,
  updater: (registry: SkillRegistry) => { registry: SkillRegistry; result: T } | Promise<{ registry: SkillRegistry; result: T }>
): Promise<T> {
  return withStoreLock(projectPath, async () => {
    const { registry } = await readSkillRegistry(projectPath);
    const next = await updater(registry);
    await writeSkillRegistry(projectPath, next.registry);
    return next.result;
  });
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
    case "opencode":
      return `.agents/skills/hyper-${name}/SKILL.md`;
    default:
      return `.visp/hyper/skills/hyper-${name}.md`;
  }
}

function renderSkill(proposal: SkillProposal, tool: string): string {
  if (tool === "copilot") {
    return [
      "---",
      'applyTo: "**"',
      "---",
      "",
      `# hyper-${proposal.name}`,
      "",
      proposal.description,
      "",
      `Use when: ${proposal.whenToUse}`,
      "",
      proposal.body,
      ""
    ].join("\n");
  }
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
export type SkillInstallResult = { installed: boolean; destination: string; warning?: string };

export async function installSkill(
  projectPath: string,
  proposal: SkillProposal,
  input: { tool: string; sessionId: string; sessionCount: number }
): Promise<SkillInstallResult> {
  const destination = destinationFor(input.tool, proposal.name);
  const destinationPath = join(projectPath, destination);

  if (await fileExists(destinationPath)) {
    return {
      installed: false,
      destination,
      warning: `skill destination already exists; skipped install of hyper-${proposal.name} at ${destination}.`
    };
  }

  await writeText(destinationPath, renderSkill(proposal, input.tool));

  // The existence probe above and this write are not one atomic step, so two
  // concurrent harvests can both reach here for the same proposal. Re-check the
  // name INSIDE the lock and make the registration idempotent, otherwise the
  // registry gains a duplicate entry whose usage counts then diverge.
  return updateSkillRegistry<SkillInstallResult>(projectPath, (registry) => {
    if (registry.skills.some((entry) => entry.name === proposal.name)) {
      return {
        registry,
        result: {
          installed: false,
          destination,
          warning: `skill hyper-${proposal.name} was already registered by a concurrent run; skipped duplicate registration.`
        }
      };
    }
    return {
      registry: {
        skills: [
          ...registry.skills,
          {
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
          }
        ]
      },
      result: { installed: true, destination }
    };
  });
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
  return updateSkillRegistry(projectPath, (registry) => {
    if (!registry.skills.some((entry) => entry.name === name)) {
      return { registry, result: false };
    }
    const at = new Date().toISOString();
    return {
      registry: {
        skills: registry.skills.map((entry) =>
          entry.name === name
            ? {
                ...entry,
                usedCount: entry.usedCount + 1,
                lastUsedAt: at,
                lastUsedSessionCount: input.sessionCount
              }
            : entry
        )
      },
      result: true
    };
  });
}
