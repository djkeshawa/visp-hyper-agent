import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export const toolNames = [
  "generic",
  "codex",
  "claude-code",
  "copilot",
  "opencode"
] as const;

export type ToolName = (typeof toolNames)[number];

const relativeAssetPathSchema = z.string().min(1).refine(isSafeRelativePath, {
  message: "must be a normalized relative path without '.', '..', or backslash segments"
});

const assetSchema = z.object({
  templatePath: relativeAssetPathSchema,
  destination: relativeAssetPathSchema
}).strict();

const capabilitySupportSchema = z.enum([
  "native",
  "surface_limited",
  "manual",
  "unsupported"
]);

export const hostCapabilityManifestSchema = z.object({
  manifestVersion: z.literal("1.0"),
  host: z.enum(toolNames),
  validatedAgainst: z.object({
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    hostVersion: z.string().min(1).nullable(),
    surface: z.string().min(1),
    documentation: z.array(z.string().url()).min(1)
  }).strict(),
  supports: z.object({
    repoGuidance: capabilitySupportSchema,
    skills: capabilitySupportSchema,
    commands: capabilitySupportSchema,
    hooks: capabilitySupportSchema,
    mcp: capabilitySupportSchema,
    subagents: capabilitySupportSchema,
    verifierRole: capabilitySupportSchema,
    challengerRole: capabilitySupportSchema,
    automaticModelSelection: capabilitySupportSchema
  }).strict(),
  fallbacks: z.object({
    mechanicalEnforcement: z.enum(["native_hooks", "git_and_ci"]),
    orchestration: z.enum(["native_subagents", "sequential"]),
    modelSelection: z.enum(["automatic", "host_controlled", "advisory"])
  }).strict(),
  assets: z.array(assetSchema).min(1)
}).strict();

export type HostCapabilityManifest = z.infer<typeof hostCapabilityManifestSchema>;
export type HostAssetSpec = HostCapabilityManifest["assets"][number];

export type LoadedHostCapabilityManifest = {
  manifest: HostCapabilityManifest;
  toolDir: string;
  sha256: string;
};

export async function loadHostCapabilityManifest(
  tool: ToolName,
  toolDir: string
): Promise<LoadedHostCapabilityManifest> {
  const manifestPath = join(toolDir, "capabilities.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(
      `Host capability manifest not found or unreadable at ${manifestPath}: ${errorMessage(error)}`
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Host capability manifest is not valid JSON at ${manifestPath}: ${errorMessage(error)}`);
  }

  const parsed = hostCapabilityManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `Host capability manifest is invalid at ${manifestPath}: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`)
        .join("; ")}`
    );
  }
  if (parsed.data.host !== tool) {
    throw new Error(
      `Host capability manifest at ${manifestPath} declares ${parsed.data.host}; expected ${tool}.`
    );
  }

  const destinations = new Set<string>();
  for (const asset of parsed.data.assets) {
    if (destinations.has(asset.destination)) {
      throw new Error(
        `Host capability manifest at ${manifestPath} contains duplicate destination ${asset.destination}.`
      );
    }
    destinations.add(asset.destination);
    const templatePath = join(toolDir, asset.templatePath);
    if (!(await isFile(templatePath))) {
      throw new Error(
        `Host capability manifest at ${manifestPath} references missing template ${asset.templatePath}.`
      );
    }
  }

  return {
    manifest: parsed.data,
    toolDir,
    sha256: createHash("sha256").update(raw).digest("hex")
  };
}

function isSafeRelativePath(value: string): boolean {
  if (isAbsolute(value) || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
