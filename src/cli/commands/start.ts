import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Command, Option } from "commander";
import { buildContextManifest, renderContextManifest } from "../../context/context-manifest.js";
import { scanRelevantFiles } from "../../context/relevance-scanner.js";
import { defaultConfig } from "../../core/defaults.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import { ProjectPathError, resolveProjectFile } from "../../core/project-path.js";
import { createSession, initializeProject, readConfig } from "../../core/session-manager.js";
import type { ContextFile, ContextManifest, ContextPackOptions, HyperConfig, SessionRecord, ToolProfile } from "../../core/types.js";
import { buildHandoffProtocol, renderHandoff } from "../../handoff/handoff-protocol.js";
import {
  detectVisp,
  type KitContextPackArtifact
} from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop, type KitAvailability } from "../../kit/kit-availability.js";
import { readKitArtifacts } from "../../kit/kit-reader.js";
import type { KitContextPack, KitIntegrationContract } from "../../kit/kit-schemas.js";
import { readMemoryPack } from "../../memory/file-memory-provider.js";
import { readRelevantFailurePatterns } from "../../memory/failure-patterns.js";
import { LlmMemoryProvider } from "../../memory/llm-memory-provider.js";
import { selectMemoryProvider } from "../../memory/provider-factory.js";
import { readSkillRegistry } from "../../skills/skill-registry.js";
import {
  type RecalledMemory,
  renderAgentInstructions,
  renderContextPack,
  renderMemoryPack,
  renderQualityGates,
  renderSession
} from "../../output/markdown-writer.js";
import { resolveProjectPath } from "./shared.js";

export function startCommand(): Command {
  return new Command("start")
    .description("Start a guided coding session and print an Agent Handoff Protocol block.")
    .argument("<goal>", "Implementation goal.")
    .addOption(
      new Option("--tool <tool>", "Tool profile.")
        .choices(["generic", "codex", "claude-code", "copilot", "opencode"])
    )
    .action(async function (this: Command, goal: string, options: { tool?: ToolProfile }) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state !== "absent") {
        console.log(renderDirectCommandKitStop("start", kit));
        process.exitCode = 1;
        return;
      }
      const { handoff } = await executeStart(projectPath, goal, {
        ...options,
        authority: { mode: "local" }
      });
      console.log(handoff);
    });
}

export type StartResult = {
  session: SessionRecord;
  handoff: string;
};

export type StartOptions = {
  tool?: ToolProfile;
  authority:
    | { mode: "local" }
    | {
        mode: "kit";
        adoption: KitAdoption;
      };
};

/** Render the shared fail-closed result for local-only command entry points. */
export function renderDirectCommandKitStop(
  command: "start" | "quick",
  kit: Exclude<KitAvailability, { state: "absent" }>
): string {
  if (kit.state === "configured-unhealthy") {
    return renderKitAuthorityStop({
      status: "INCONCLUSIVE",
      reasonCode: kit.reasonCode,
      reason: `Direct ${command} is local-only, and the configured Kit could not be evaluated: ${kit.reason}`
    });
  }
  return renderKitAuthorityStop({
    status: "BLOCKED",
    reasonCode: `direct_${command}_requires_kitless_project`,
    reason: `Direct ${command} is local-only. This project has a healthy Kit; use visp-hyper run to consume its authoritative workflow.`
  });
}

/**
 * Run the full start pipeline (session creation, kit context adoption, memory
 * fusion, and all `.visp/hyper/current/` writes) and return the created session
 * plus the rendered handoff block. Callers must supply an already resolved
 * authority mode so a configured Kit failure can never become local fallback.
 */
export async function executeStart(
  projectPath: string,
  goal: string,
  options: StartOptions
): Promise<StartResult> {
  await preflightStartWrites(projectPath, defaultConfig.blockedPaths);
  await initializeProject(projectPath);
  const config = await readConfig(projectPath);
  await preflightStartWrites(projectPath, config.blockedPaths);
  const tool = options.tool ?? config.defaultTool;
  const adoption = options.authority.mode === "kit" ? options.authority.adoption : undefined;
  const kit = await readKitArtifacts(projectPath);
  const memory = await readMemoryPack(projectPath);
  const memoryFusion = await fuseRecalledMemory(projectPath, config, goal);
  const contextFiles =
    adoption?.files ??
    (await scanRelevantFiles({
      projectPath,
      goal,
      blockedPaths: config.blockedPaths
    }));
  const contextOptions: ContextPackOptions = adoption
    ? { source: adoption.source, validationCommands: adoption.validationCommands }
    : {};
  const contextSource = contextOptions.source ?? "visp-hyper relevance scanner";
  const validationCommands = contextOptions.validationCommands ?? [];
  const contextKit = adoption ? { ...kit, warnings: [...kit.warnings, ...adoption.warnings] } : kit;
  const failurePatterns = await readRelevantFailurePatterns(projectPath, {
    goal,
    taskId: adoption?.taskId,
    files: contextFiles.map((file) => file.path)
  });
  const session = await createSession({
    projectPath,
    goal,
    tool,
    relevantFiles: contextFiles.map((file) => file.path)
  });
  const { registry } = await readSkillRegistry(projectPath, { blockedPaths: config.blockedPaths });
  const handoff = renderHandoff(session, {
    skills: registry.skills.map((skill) => ({ name: skill.name, whenToUse: skill.whenToUse }))
  });
  const protocol = buildHandoffProtocol(session);
  const contextManifest = buildContextManifest({
    session,
    contextSource,
    taskId: adoption?.taskId,
    contextArtifact: adoption?.contextArtifact,
    artifactProvenance: adoption?.artifactProvenance,
    freshnessWarnings: adoption?.freshnessWarnings,
    kitReadContract: adoption?.kitReadContract,
    contextFiles,
    validationCommands,
    blockedPaths: config.blockedPaths,
    failurePatterns,
    nextCommand: adoption?.taskId ? `visp-hyper checkpoint --task ${adoption.taskId}` : "visp-hyper next"
  });

  await writeText(vispPath(projectPath, "hyper", "current", "session.md"), renderSession(session));
  await writeText(
    vispPath(projectPath, "hyper", "current", "context-pack.md"),
    renderContextPack(contextFiles, contextKit, contextOptions)
  );
  await writeText(
    vispPath(projectPath, "hyper", "current", "context-manifest.json"),
    renderContextManifest(contextManifest)
  );
  await writeText(
    vispPath(projectPath, "hyper", "current", "memory-pack.md"),
    renderMemoryPack(memory, {
      recalled: memoryFusion.recalled,
      recalledWarnings: memoryFusion.warnings,
      failurePatterns
    })
  );
  await writeText(vispPath(projectPath, "hyper", "current", "quality-gates.md"), renderQualityGates(config.blockedPaths));
  await writeText(vispPath(projectPath, "hyper", "current", "agent-instructions.md"), renderAgentInstructions(session));
  await writeText(
    vispPath(projectPath, "hyper", "current", "handoff.json"),
    `${JSON.stringify({ ...protocol, session }, null, 2)}\n`
  );
  await writeText(join(projectPath, ".visp", "prompts", "visp-hyper-handoff.prompt.md"), `${handoff}\n`);

  return { session, handoff };
}

const maxContentLength = 12_000;

const recallLimit = 10;

const managedStartWritePaths = [
  ".visp/hyper/config.json",
  ".visp/hyper/state.json",
  ".visp/hyper/current/session.md",
  ".visp/hyper/current/context-pack.md",
  ".visp/hyper/current/context-manifest.json",
  ".visp/hyper/current/memory-pack.md",
  ".visp/hyper/current/quality-gates.md",
  ".visp/hyper/current/agent-instructions.md",
  ".visp/hyper/current/handoff.json",
  ".visp/memory/session-history/.visp-hyper-path-check",
  ".visp/prompts/visp-hyper-handoff.prompt.md"
];

async function preflightStartWrites(projectPath: string, blockedPaths: string[]): Promise<void> {
  const destinations = new Map<string, string>();
  for (const path of managedStartWritePaths) {
    const resolved = await resolveProjectFile(projectPath, path, {
      mode: "write",
      blockedPaths
    });
    const key = process.platform === "win32" ? resolved.absolutePath.toLowerCase() : resolved.absolutePath;
    const existing = destinations.get(key);
    if (existing) {
      throw new ProjectPathError(path, `managed output aliases ${existing}`);
    }
    destinations.set(key, path);
  }
}

type MemoryFusion = {
  recalled?: RecalledMemory[];
  warnings: string[];
};

/**
 * In llm-memory mode with a healthy server, recall memories relevant to the goal
 * so they can be fused into the memory pack. File mode (or a fallback) contributes
 * no recalled entries; fallback warnings are surfaced so the user sees the degradation.
 */
async function fuseRecalledMemory(projectPath: string, config: HyperConfig, goal: string): Promise<MemoryFusion> {
  const selection = await selectMemoryProvider({ config, projectPath });
  if (!(selection.provider instanceof LlmMemoryProvider)) {
    return { warnings: selection.warnings };
  }
  const detailed = await selection.provider.recallDetailed(goal, { limit: recallLimit });
  const recalled: RecalledMemory[] = [];
  const quarantined: string[] = [];
  for (const entry of detailed) {
    if (looksLikeInstructionInjection(entry.result.content)) {
      quarantined.push("quarantined an instruction-like recalled memory; content omitted");
      continue;
    }
    recalled.push({
      summary: entry.result.summary,
      content: entry.result.content,
      category: entry.category,
      score: entry.score,
      provenance: "llm-memory",
      sourceUri: entry.result.path,
      scope: "project",
      ttl: "session",
      trust: "untrusted-context"
    });
  }
  return {
    recalled: recalled.length > 0 ? recalled : undefined,
    warnings: [...selection.warnings, ...selection.provider.warnings, ...quarantined]
  };
}

function looksLikeInstructionInjection(content: string): boolean {
  return /(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|system|developer)|\b(?:must|always)\s+(?:run|execute|install|edit|delete)|(?:grant|expand)\s+(?:permission|access)/iu.test(content);
}

export type KitAdoption = {
  files: ContextFile[];
  source: string;
  taskId: string;
  contextArtifact: {
    path: string;
    hash: string;
    hashAlgorithm: "sha256";
  };
  artifactProvenance: Array<{
    label: string;
    path: string;
    hash: string;
    hashAlgorithm: "sha256";
    source: "visp-kit";
  }>;
  kitReadContract?: ContextManifest["kitReadContract"];
  freshnessWarnings: string[];
  validationCommands: string[];
  warnings: string[];
};

/**
 * Convert an already validated, contract-pinned Kit context artifact into the
 * exact adoption object used by `executeStart`. This deliberately performs no
 * Kit probe and exposes an empty/fully-blocked pack before the implement gate.
 */
export async function prepareStrictKitAdoption(
  projectPath: string,
  input: {
    taskId: string;
    artifact: KitContextPackArtifact;
    contract: KitIntegrationContract;
  }
): Promise<KitAdoption | undefined> {
  if (
    input.contract.orchestrator?.readContractVersion !== "0.1" ||
    !input.artifact.prompt ||
    !input.artifact.currentPrompt
  ) {
    return undefined;
  }
  const config = await readConfig(projectPath);
  return buildKitAdoption({
    projectPath,
    config,
    taskId: input.taskId,
    artifact: input.artifact,
    contract: input.contract,
    authorityWarnings: []
  });
}

async function buildKitAdoption(input: {
  projectPath: string;
  config: HyperConfig;
  taskId: string;
  artifact: KitContextPackArtifact;
  contract: KitIntegrationContract | null;
  authorityWarnings: string[];
}): Promise<KitAdoption | undefined> {
  const { projectPath, config, taskId, artifact, contract } = input;

  const context = await contextFilesFromPack(artifact.pack, projectPath, config.blockedPaths);
  if (context.files.length === 0 || context.integrityFailed) {
    for (const warning of context.warnings) {
      console.warn(`warning: ${warning}`);
    }
    return undefined;
  }

  const artifactProvenance = (artifact.pack.artifactProvenance ?? []).map((entry) => ({
    ...entry,
    source: "visp-kit" as const
  }));
  const freshnessWarnings =
    artifactProvenance.length === 0
      ? [missingProvenanceWarning(taskId)]
      : [];

  return {
    files: context.files,
    source: `visp-kit context pack (${taskId})`,
    taskId,
    contextArtifact: {
      path: normalizeRelative(projectPath, artifact.path),
      hash: artifact.sha256,
      hashAlgorithm: "sha256"
    },
    artifactProvenance,
    kitReadContract: readContractFromKit(contract, taskId),
    freshnessWarnings,
    validationCommands: artifact.pack.validationCommands ?? [],
    warnings: [...input.authorityWarnings, ...freshnessWarnings, ...context.warnings]
  };
}

function readContractFromKit(
  contract: KitIntegrationContract | null,
  activeTaskId: string
): ContextManifest["kitReadContract"] | undefined {
  if (!contract?.orchestrator?.readContractVersion) {
    return undefined;
  }
  if (contract.activeTask && contract.activeTask.id !== activeTaskId) {
    return undefined;
  }
  const requiredArtifacts = contract.orchestrator.requiredArtifacts ?? [];
  if (requiredArtifacts.length === 0) {
    return undefined;
  }

  return {
    contractVersion: contract.contractVersion,
    readContractVersion: contract.orchestrator.readContractVersion,
    requiredArtifacts: requiredArtifacts.map((artifact) => ({
      id: artifact.id,
      path: artifact.path,
      role: artifact.role,
      mimeType: artifact.mimeType,
      requiredFor: artifact.requiredFor ?? [],
      freshness: artifact.freshness ?? "read-latest"
    })),
    ...(contract.orchestrator.freshnessPolicy
      ? {
          freshnessPolicy: {
            ...(contract.orchestrator.freshnessPolicy.contextPackHashPinned === undefined
              ? {}
              : { contextPackHashPinned: contract.orchestrator.freshnessPolicy.contextPackHashPinned }),
            ...(contract.orchestrator.freshnessPolicy.provenanceArtifactsHashPinned === undefined
              ? {}
              : { provenanceArtifactsHashPinned: contract.orchestrator.freshnessPolicy.provenanceArtifactsHashPinned }),
            staleContextBlocks: contract.orchestrator.freshnessPolicy.staleContextBlocks ?? []
          }
        }
      : {})
  };
}

async function contextFilesFromPack(
  pack: KitContextPack,
  projectPath: string,
  blockedPaths: string[]
): Promise<{ files: ContextFile[]; warnings: string[]; integrityFailed: boolean }> {
  const entries = pack.includedFiles ?? pack.files ?? [];
  const files: ContextFile[] = [];
  const warnings: string[] = [];
  const selectedPaths = new Set<string>();
  let integrityFailed = false;
  for (const entry of entries) {
    const provided = entry.content ?? entry.snippet;
    const plannedNewFile = entry.includeMode === "new-file" && entry.hash === "new-file";
    let resolved;
    try {
      resolved = await resolveProjectFile(projectPath, entry.path, {
        mode: plannedNewFile || provided !== undefined ? "write" : "read",
        blockedPaths
      });
    } catch {
      warnings.push("Skipped an unsafe or unreadable context entry.");
      integrityFailed = true;
      continue;
    }

    if (selectedPaths.has(resolved.logicalPath)) {
      warnings.push(`Rejected duplicate context file ${resolved.logicalPath}.`);
      integrityFailed = true;
      continue;
    }
    selectedPaths.add(resolved.logicalPath);

    if (plannedNewFile) {
      if (resolved.exists) {
        warnings.push(
          `Rejected planned new file ${resolved.logicalPath}: the target already exists.`
        );
        integrityFailed = true;
        continue;
      }
      if (provided !== undefined && provided.trim().length === 0) {
        warnings.push(`Rejected blank context file ${resolved.logicalPath}.`);
        integrityFailed = true;
        continue;
      }
      files.push({
        path: resolved.logicalPath,
        reason: entry.reason ?? "visp-kit planned new file",
        content:
          provided === undefined
            ? "Planned new file; no existing source content."
            : truncateContent(provided)
      });
      continue;
    }

    const source =
      provided === undefined
        ? await readPackFile(resolved.absolutePath)
        : { content: provided, sha256: hashContent(provided) };
    if (source === undefined) {
      warnings.push(`Skipped unreadable context file ${resolved.logicalPath}.`);
      integrityFailed = true;
      continue;
    }
    if (source.content.trim().length === 0) {
      warnings.push(`Rejected blank context file ${resolved.logicalPath}.`);
      integrityFailed = true;
      continue;
    }
    if (!entry.hash || !/^[a-f0-9]{64}$/u.test(entry.hash)) {
      warnings.push(`Rejected context file ${resolved.logicalPath}: missing or invalid SHA-256.`);
      integrityFailed = true;
      continue;
    }
    if (source.sha256 !== entry.hash) {
      warnings.push(
        `Rejected context file ${resolved.logicalPath}: content did not match the authoritative SHA-256.`
      );
      integrityFailed = true;
      continue;
    }
    files.push({
      path: resolved.logicalPath,
      reason: entry.reason ?? "visp-kit context pack",
      content: truncateContent(source.content),
      sourceHash: entry.hash,
      sourceHashAlgorithm: "sha256" as const,
      sourceHashSource: "visp-kit" as const
    });
  }
  return { files, warnings, integrityFailed };
}

function normalizeRelative(projectPath: string, path: string): string {
  return relative(projectPath, path).replace(/\\/g, "/");
}

async function readPackFile(path: string): Promise<{ content: string; sha256: string } | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return { content, sha256: hashContent(content) };
  } catch {
    return undefined;
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function truncateContent(content: string): string {
  return content.length > maxContentLength ? `${content.slice(0, maxContentLength)}\n\n[truncated]\n` : content;
}

function missingProvenanceWarning(taskId: string): string {
  return `Kit context pack for ${taskId} has no artifactProvenance; checkpoint can pin only the context-pack file, not the spec/task/plan/policy artifacts that grounded the handoff. Regenerate the context pack with a Visp Kit that emits artifact provenance.`;
}
