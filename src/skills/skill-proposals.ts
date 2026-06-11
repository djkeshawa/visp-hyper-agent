import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { ensureDir } from "../core/fs-utils.js";

export const INCOMING_DIR = ".visp/hyper/skill-proposals/incoming";
export const REJECTED_DIR = ".visp/hyper/skill-proposals/rejected";
export const STAGED_DIR = ".visp/hyper/skill-proposals/staged";

export type SkillProposal = {
  name: string;
  description: string;
  whenToUse: string;
  evidence?: string;
  body: string;
  sourcePath: string;
};

const proposalSchema = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name must be kebab-case"),
  description: z.string().min(1, "description is required"),
  whenToUse: z.string().min(1, "when_to_use is required"),
  evidence: z.string().optional(),
  body: z.string().min(1, "body must be non-empty")
});

const FRONTMATTER_KEYS: Record<string, "name" | "description" | "whenToUse" | "evidence"> = {
  name: "name",
  description: "description",
  when_to_use: "whenToUse",
  evidence: "evidence"
};

/**
 * Parse an agent-dropped skill proposal file. The format is a constrained
 * markdown document: a `---` frontmatter fence containing `key: value` lines,
 * followed by a free-markdown body. Unknown frontmatter keys are ignored.
 * Returns a validated {@link SkillProposal} or a specific error string.
 */
export function parseProposal(
  content: string,
  sourcePath: string
): { proposal: SkillProposal } | { error: string } {
  const lines = content.split(/\r?\n/);

  let openFenceIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "") {
      continue;
    }
    if (lines[i]?.trim() === "---") {
      openFenceIndex = i;
    }
    break;
  }
  if (openFenceIndex === -1) {
    return { error: "missing frontmatter fence" };
  }

  let closeFenceIndex = -1;
  for (let i = openFenceIndex + 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      closeFenceIndex = i;
      break;
    }
  }
  if (closeFenceIndex === -1) {
    return { error: "missing frontmatter fence" };
  }

  const fields: Record<string, string> = {};
  for (let i = openFenceIndex + 1; i < closeFenceIndex; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    const mapped = FRONTMATTER_KEYS[key];
    if (mapped) {
      fields[mapped] = value;
    }
  }

  const body = lines.slice(closeFenceIndex + 1).join("\n").trim();

  const result = proposalSchema.safeParse({
    name: fields.name ?? "",
    description: fields.description ?? "",
    whenToUse: fields.whenToUse ?? "",
    evidence: fields.evidence,
    body
  });

  if (!result.success) {
    return { error: result.error.issues[0]?.message ?? "invalid skill proposal" };
  }

  return {
    proposal: {
      name: result.data.name,
      description: result.data.description,
      whenToUse: result.data.whenToUse,
      ...(result.data.evidence ? { evidence: result.data.evidence } : {}),
      body: result.data.body,
      sourcePath
    }
  };
}

/**
 * Scan the incoming proposal directory, parsing every `*.md` file. A missing
 * directory yields empty results. Each file is split into the `valid` or
 * `invalid` bucket based on {@link parseProposal}.
 */
export async function scanIncoming(
  projectPath: string
): Promise<{ valid: SkillProposal[]; invalid: Array<{ sourcePath: string; error: string }> }> {
  const dir = join(projectPath, INCOMING_DIR);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { valid: [], invalid: [] };
    }
    throw error;
  }

  const valid: SkillProposal[] = [];
  const invalid: Array<{ sourcePath: string; error: string }> = [];

  for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
    const sourcePath = join(dir, entry);
    const content = await readFile(sourcePath, "utf8");
    const parsed = parseProposal(content, sourcePath);
    if ("proposal" in parsed) {
      valid.push(parsed.proposal);
    } else {
      invalid.push({ sourcePath, error: parsed.error });
    }
  }

  return { valid, invalid };
}

/**
 * Move a rejected proposal to the rejected directory (same basename),
 * appending an HTML comment recording the rejection reason.
 */
export async function moveToRejected(
  projectPath: string,
  sourcePath: string,
  error: string
): Promise<void> {
  const destDir = join(projectPath, REJECTED_DIR);
  await ensureDir(destDir);
  const dest = join(destDir, basename(sourcePath));
  const content = await readFile(sourcePath, "utf8");
  await writeFile(dest, `${content}\n\n<!-- rejected: ${error} -->\n`, "utf8");
  await rm(sourcePath, { force: true });
}

/**
 * Move a proposal to the staged directory (same basename).
 */
export async function moveToStaged(projectPath: string, sourcePath: string): Promise<void> {
  const destDir = join(projectPath, STAGED_DIR);
  await ensureDir(destDir);
  const dest = join(destDir, basename(sourcePath));
  await rename(sourcePath, dest);
}
