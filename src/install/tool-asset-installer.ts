import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHostCapabilityManifest as loadManifest,
  type LoadedHostCapabilityManifest,
  type ToolName
} from "./host-capability-manifest.js";

export type { ToolName } from "./host-capability-manifest.js";

export type PlannedAsset = {
  /** Path to the source template, relative to the templates root. */
  templatePath: string;
  /** Path to write, relative to the project root. */
  destination: string;
  /** Whether a file already exists at the destination. */
  exists: boolean;
  /** Whether an installed file matches the rendered bundled asset. */
  integrity: "current" | "missing" | "modified";
  /** Hash of the rendered bundled asset. */
  expectedSha256: string;
  /** Hash of the installed file, when present. */
  actualSha256?: string;
};

export type InstallReport = {
  tool: ToolName;
  created: string[];
  skipped: string[];
  overwritten: string[];
  warnings: string[];
};

export async function readHostCapabilityManifest(
  tool: ToolName,
  options: { templatesDir?: string } = {}
): Promise<LoadedHostCapabilityManifest> {
  const toolDir = await resolveToolDir(tool, options.templatesDir);
  return loadManifest(tool, toolDir);
}

/** Model-map token placeholders, keyed by the model-map role they fill. */
const MODEL_TOKENS: Record<string, string> = {
  coordinator: "{{COORDINATOR_MODEL}}",
  scout: "{{SCOUT_MODEL}}",
  // P21-HYPER-01 split the scout: navigation-only kept the name, the
  // mechanical-edit duties moved to their own agent with its own model slot.
  mechanic: "{{MECHANIC_MODEL}}",
  implementer: "{{IMPLEMENTER_MODEL}}"
};

/**
 * Kit-owned destinations that this installer must never write, even if a manifest
 * mistake or a future template points at one. These belong to the external Visp Kit
 * or the host tool's own configuration and are off-limits.
 */
export function isKitOwnedDestination(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (normalized === "AGENTS.md") {
    return true;
  }
  if (normalized === ".github/copilot-instructions.md") {
    return true;
  }
  // P10-US-06: the `visp-*` slash commands under .claude/commands are now
  // Hyper-owned — one file per verb, one owner. Kit's renderer is retired.
  // Kit's own top-level agent instructions file (NOT hyper's AGENTS.visp-hyper.md).
  if (normalized === "AGENTS.visp.md") {
    return true;
  }
  // Kit-owned skill packs under .agents/skills/visp-*/ — but NOT hyper's own
  // `visp-hyper` skill directory.
  if (/^\.agents\/skills\/visp-[^/]+\//.test(normalized) && !/^\.agents\/skills\/visp-hyper\//.test(normalized)) {
    return true;
  }
  // Kit-owned Copilot instruction files .github/instructions/visp-*.instructions.md
  // — but NOT hyper's own visp-hyper.instructions.md.
  if (
    /^\.github\/instructions\/visp-[^/]+\.instructions\.md$/.test(normalized) &&
    !/^\.github\/instructions\/visp-hyper[^/]*\.instructions\.md$/.test(normalized)
  ) {
    return true;
  }
  // Kit-owned prompt rules and hook scripts under .visp/.
  if (normalized === ".visp/prompts/visp-rules.md") {
    return true;
  }
  if (normalized === ".visp/hooks" || normalized.startsWith(".visp/hooks/")) {
    return true;
  }
  return false;
}

/**
 * Resolve the bundled templates directory. From `dist/index.js` this is
 * `dist/../templates`; from `src/install/` during tests it is
 * `src/install/../../templates`. Rather than hard-code a level count, walk upward
 * from this module until a directory containing `templates/claude-code` is found.
 */
export function templatesRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (let depth = 0; depth <= 4; depth += 1) {
    const candidate = join(current, "templates");
    if (existsSyncDir(join(candidate, "claude-code"))) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    `Could not locate the templates directory starting from ${start}. Expected a "templates/claude-code" folder within 4 levels up.`
  );
}

export async function planInstall(
  tool: ToolName,
  projectPath: string,
  options: { templatesDir?: string } = {}
): Promise<PlannedAsset[]> {
  const toolDir = await resolveToolDir(tool, options.templatesDir);
  const { manifest } = await loadManifest(tool, toolDir);
  const models = await readModelMap(toolDir);
  const planned: PlannedAsset[] = [];
  for (const spec of manifest.assets) {
    // Consult the same denylist installAssets enforces so plan and install
    // agree: a kit-owned destination is never written, so it must never appear
    // in the plan.
    if (isKitOwnedDestination(spec.destination)) {
      continue;
    }
    const destAbsolute = join(projectPath, spec.destination);
    await assertSafeDestination(projectPath, spec.destination);
    const expected = render(await readFile(join(toolDir, spec.templatePath), "utf8"), models);
    const actual = await readText(destAbsolute);
    const expectedSha256 = hashText(expected);
    const actualSha256 = actual === undefined ? undefined : hashText(actual);
    planned.push({
      templatePath: spec.templatePath,
      destination: spec.destination,
      exists: actual !== undefined,
      integrity:
        actual === undefined
          ? "missing"
          : actualSha256 === expectedSha256
            ? "current"
            : "modified",
      expectedSha256,
      ...(actualSha256 ? { actualSha256 } : {})
    });
  }
  return planned;
}

export async function installAssets(
  tool: ToolName,
  projectPath: string,
  options: { force?: boolean; templatesDir?: string } = {}
): Promise<InstallReport> {
  const toolDir = await resolveToolDir(tool, options.templatesDir);
  const { manifest } = await loadManifest(tool, toolDir);
  const force = options.force ?? false;
  const report: InstallReport = { tool, created: [], skipped: [], overwritten: [], warnings: [] };
  const models = await readModelMap(toolDir);

  for (const spec of manifest.assets) {
    if (isKitOwnedDestination(spec.destination)) {
      report.warnings.push(`Refused to write kit-owned destination ${spec.destination}.`);
      continue;
    }

    const destAbsolute = join(projectPath, spec.destination);
    await assertSafeDestination(projectPath, spec.destination);
    const exists = await pathExists(destAbsolute);
    if (exists && !force) {
      report.skipped.push(spec.destination);
      report.warnings.push(`Skipped existing file ${spec.destination}; pass force to overwrite.`);
      continue;
    }

    const raw = await readFile(join(toolDir, spec.templatePath), "utf8");
    const rendered = render(raw, models);
    await mkdir(dirname(destAbsolute), { recursive: true });
    await assertSafeDestination(projectPath, spec.destination);
    await writeFile(destAbsolute, rendered, "utf8");

    if (exists) {
      report.overwritten.push(spec.destination);
    } else {
      report.created.push(spec.destination);
    }
  }

  return report;
}

/**
 * Resolve and validate the tool's template subdirectory, throwing BEFORE any write
 * if the templates root or the tool subdir is missing.
 */
async function resolveToolDir(tool: ToolName, templatesDir?: string): Promise<string> {
  const root = templatesDir ?? templatesRoot();
  if (!(await pathIsDir(root))) {
    throw new Error(`Templates directory not found: ${root}`);
  }
  const toolDir = join(root, tool);
  if (!(await pathIsDir(toolDir))) {
    throw new Error(`Templates for tool "${tool}" not found at ${toolDir}`);
  }
  return toolDir;
}

async function readModelMap(toolDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(toolDir, "model-map.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") {
          map[key] = value;
        }
      }
      return map;
    }
  } catch {
    // No model-map.json (or unreadable) → no tokens to substitute. Bodies without
    // tokens render unchanged; this is expected for non-claude-code tools.
  }
  return {};
}

function render(content: string, models: Record<string, string>): string {
  let out = content;
  for (const [role, token] of Object.entries(MODEL_TOKENS)) {
    const value = models[role];
    if (value !== undefined) {
      out = out.split(token).join(value);
    }
  }
  return out;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertSafeDestination(projectPath: string, destination: string): Promise<void> {
  const projectReal = await realpath(projectPath);
  const segments = destination.replace(/\\/gu, "/").split("/");
  let candidate = projectPath;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Refused host asset destination through symlink or junction: ${destination}.`);
    }
    const resolved = await realpath(candidate);
    const fromProject = relative(projectReal, resolved);
    if (fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject)) {
      throw new Error(`Refused host asset destination outside the project: ${destination}.`);
    }
  }
}

async function pathIsDir(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function existsSyncDir(path: string): boolean {
  try {
    // Synchronous probe is acceptable here: templatesRoot() runs once at startup
    // and must return a plain string for non-async callers.
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
