import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { Command, Option } from "commander";
import { buildContextManifest, renderContextManifest } from "../../context/context-manifest.js";
import { scanRelevantFiles } from "../../context/relevance-scanner.js";
import { defaultConfig } from "../../core/defaults.js";
import { vispPath, writeText } from "../../core/fs-utils.js";
import {
  createSession,
  initializeProject,
  readConfig,
  updateActiveSession
} from "../../core/session-manager.js";
import type {
  ContextFile,
  ContextManifest,
  ContextPackOptions,
  HyperConfig,
  SessionRecord,
  ToolProfile
} from "../../core/types.js";
import { buildHandoffProtocol, renderHandoff } from "../../handoff/handoff-protocol.js";
import { isBlockedPath } from "../../governance/blocked-files.js";
import {
  detectVisp,
  type KitContextPackArtifact
} from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop, type KitAvailability } from "../../kit/kit-availability.js";
import { readKitArtifacts } from "../../kit/kit-reader.js";
import type { KitContextPack, KitIntegrationContract } from "../../kit/kit-schemas.js";
import type { NormalizedWorkflowAction } from "../../kit/workflow-action-adapter.js";
import { readMemoryPack } from "../../memory/file-memory-provider.js";
import type { MemoryRecallScope } from "../../memory/memory-cli-contract.js";
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
import { isRecord } from "../../core/guards.js";

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
  /**
   * A4(a). What this task must respect, forwarded to memory recall so ranking
   * knows the shape of the work. Kit-backed runs supply the authoritative
   * forbidden paths and acceptance statements from the workflow action; a
   * local run has none and sends none. Nothing here is authority — it is
   * retrieval context only.
   */
  constraints?: readonly string[];
};

/**
 * Environment scope tags for recall eligibility.
 *
 * A stored memory that declares an environment is rejected outright when the
 * caller declares none, so sending nothing was actively hiding rows. These are
 * facts about where the work is happening, not a guess: the platform, the Node
 * major, and the host the session runs in.
 */
function recallEnvironment(tool: ToolProfile): string[] {
  const nodeMajor = process.versions.node.split(".")[0] ?? "";
  return [process.platform, nodeMajor.length > 0 ? `node${nodeMajor}` : "", tool].filter(
    (value) => value.length > 0
  );
}

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
    reason: `Direct ${command} is local-only. This project has a healthy Kit; use \`visp work\` to consume its authoritative workflow.`
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
  const adoption = options.authority.mode === "kit" ? options.authority.adoption : undefined;
  await initializeProject(projectPath);
  const config = adoption?.config ?? (await readConfig(projectPath));
  const tool = options.tool ?? config.defaultTool;
  const kit = await readKitArtifacts(projectPath);
  const memory = await readMemoryPack(projectPath);
  const contextFiles =
    adoption?.files ??
    (await scanRelevantFiles({
      projectPath,
      goal,
      blockedPaths: config.blockedPaths
    }));
  // File names are the reliable associative key in a default install, where
  // recall is effectively lexical: completions record the files they touched,
  // and the next task knows the files it is about to touch.
  const recallHints = contextFiles
    .slice(0, 3)
    .map((file) => file.path.split("/").at(-1) ?? "")
    .filter((name) => name.length > 0);
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
  const createdSession = await createSession({
    projectPath,
    goal,
    tool,
    relevantFiles: contextFiles.map((file) => file.path)
  });
  const session = adoption
    ? (await updateActiveSession(projectPath, (current) => ({
        ...current,
        pipeline: {
          taskIds: [adoption.taskId],
          currentTaskId: adoption.taskId,
          completed: [],
          stepHistory: []
        }
      }))) ?? createdSession
    : createdSession;

  // A4(a). Recall runs here, AFTER the session exists, because the session id
  // is part of what it is being told. Everything below was already in hand at
  // this point and was previously thrown away at the contract boundary: the
  // task sentence, the exact files the task touches, the constraints Kit
  // declared, and the environment. Hints lead the query itself:
  // goalRecallQuery keeps the first eight distinct terms, and the file names
  // are the strongest associative key, so they must never be what truncation
  // drops.
  const memoryFusion = await fuseRecalledMemory(
    projectPath,
    config,
    [...recallHints, goal].join(" "),
    {
      task: goal,
      files: contextFiles.map((file) => file.path),
      constraints: options.constraints ?? [],
      sessionId: session.id,
      environment: recallEnvironment(tool)
      // `asOf` is deliberately not sent. Omitting it means "now", which is what
      // the working loop wants; pinning any earlier instant would hide memories
      // written during the session, and pinning "now" is the same thing with
      // extra argv.
    }
  );

  const { registry } = await readSkillRegistry(projectPath);
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
    nextCommand: adoption?.nextCommand ?? "visp-hyper next"
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

type MemoryFusion = {
  recalled?: RecalledMemory[];
  warnings: string[];
};

/**
 * In llm-memory mode with a healthy server, recall memories relevant to the goal
 * so they can be fused into the memory pack. File mode (or a fallback) contributes
 * no recalled entries; fallback warnings are surfaced so the user sees the degradation.
 */
async function fuseRecalledMemory(
  projectPath: string,
  config: HyperConfig,
  goal: string,
  scope: MemoryRecallScope
): Promise<MemoryFusion> {
  const selection = await selectMemoryProvider({ config, projectPath });
  if (!(selection.provider instanceof LlmMemoryProvider)) {
    // The standard install runs NO memory server: `visp setup` configures
    // llm-memory over the visp-memory CLI contract, exactly as the recall and
    // learn verbs speak it. The fusion used to be HTTP-only, so in every
    // ordinary project it silently degraded to file mode and memory-pack.md
    // carried nothing — the store `visp-memory init` seeds from git history
    // was never read by the working loop at all.
    if (config.memoryMode === "llm-memory") {
      return recallViaContract(projectPath, config, goal, selection.warnings, scope);
    }
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

const RECALL_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "at", "for", "and", "or", "with",
  "so", "that", "it", "is", "are", "be", "by", "from", "into", "when", "then",
  "this", "there", "should", "must", "can", "will", "we", "i", "you"
]);

/**
 * Turn a goal sentence into the query memory can actually answer.
 *
 * Memory's relevance threshold is tuned for query-shaped queries; a full goal
 * sentence ("add a farewell message to app.js") dilutes its own lexical
 * overlap across every filler word and scores below the bar even when the
 * store holds exactly the fact needed. Identifiers (anything with a dot,
 * digit, underscore or hyphen) always survive; ordinary stopwords never do.
 */
export function goalRecallQuery(goal: string): string {
  const terms = goal
    .split(/\s+/u)
    .map((term) => term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, ""))
    .filter((term) => term.length > 1)
    .filter(
      (term) => /[.\d_-]/u.test(term) || !RECALL_STOPWORDS.has(term.toLowerCase())
    );
  const distinct = [...new Set(terms.map((term) => term.toLowerCase()))].slice(0, 8);
  return distinct.length > 0 ? distinct.join(" ") : goal;
}

/**
 * Recall over the visp-memory CLI contract — the transport the verbs use and
 * the only one a standard install has. Entries get the same injection
 * quarantine as the HTTP path; nothing recalled is ever trusted as
 * instructions.
 */
export async function recallViaContract(
  projectPath: string,
  config: HyperConfig,
  goal: string,
  priorWarnings: readonly string[] = [],
  scope: MemoryRecallScope = {}
): Promise<MemoryFusion> {
  const { memoryContractRecall } = await import("../../memory/memory-cli-contract.js");
  const result = await memoryContractRecall({
    projectPath,
    endpoint: config.memoryEndpoint,
    repoId: config.memoryRepoId,
    query: goalRecallQuery(goal),
    // The pack is rank-limited, budget-capped, and marked untrusted-context;
    // moderate precision is acceptable there, silence is not. The default
    // floor is tuned for precise human queries and stays untouched for them.
    minScore: 0.35,
    scope
  });
  if (!result.ok) {
    return { warnings: [...priorWarnings, `memory recall unavailable: ${result.reason}`] };
  }
  const recalled: RecalledMemory[] = [];
  const warnings: string[] = [...priorWarnings];
  if (result.degraded !== undefined) {
    warnings.push(result.degraded);
  }
  for (const entry of result.entries.slice(0, recallLimit)) {
    if (looksLikeInstructionInjection(entry.content)) {
      warnings.push("quarantined an instruction-like recalled memory; content omitted");
      continue;
    }
    recalled.push({
      summary: entry.content.length > 120 ? `${entry.content.slice(0, 119)}…` : entry.content,
      content: entry.content,
      category: entry.kind,
      score: null,
      provenance: "llm-memory",
      sourceUri: "visp-memory (CLI contract)",
      scope: "project",
      ttl: "session",
      trust: "untrusted-context"
    });
  }
  return { recalled: recalled.length > 0 ? recalled : undefined, warnings };
}

function looksLikeInstructionInjection(content: string): boolean {
  return /(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|system|developer)|\b(?:must|always)\s+(?:run|execute|install|edit|delete)|(?:grant|expand)\s+(?:permission|access)/iu.test(content);
}

export type KitAdoption = {
  config: HyperConfig;
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
  nextCommand: string;
  warnings: string[];
};

export type StrictKitAdoptionDiagnostic =
  | { ok: true; value: KitAdoption }
  | {
      ok: false;
      reasonCode:
        | "hyper_config_unavailable"
        | "strict_session_task_mismatch"
        | "context_pack_required_read_missing"
        | "context_pack_path_mismatch"
        | "context_pack_hash_mismatch"
        | "context_pack_task_mismatch"
        | "context_pack_validation_commands_mismatch"
        | "context_pack_selected_file_blocked"
        | "context_pack_selected_file_invalid"
        | "context_pack_selected_file_unavailable";
      reason: string;
    };

/**
 * Convert an already validated, contract-pinned Kit context artifact into the
 * exact adoption object used by `executeStart`. This path is read-only: a
 * failed admission check must not initialize Hyper or create session state.
 */
export async function prepareStrictKitAdoption(
  projectPath: string,
  input: {
    action: NormalizedWorkflowAction;
    artifact: KitContextPackArtifact;
    contract: KitIntegrationContract;
  }
): Promise<StrictKitAdoptionDiagnostic> {
  const configDiagnostic = await readStrictConfigSnapshot(projectPath);
  if (!configDiagnostic.ok) {
    return configDiagnostic;
  }
  return buildKitAdoption({
    projectPath,
    config: configDiagnostic.value,
    action: input.action,
    artifact: input.artifact,
    contract: input.contract
  });
}

async function buildKitAdoption(input: {
  projectPath: string;
  config: HyperConfig;
  action: NormalizedWorkflowAction;
  artifact: KitContextPackArtifact;
  contract: KitIntegrationContract;
}): Promise<StrictKitAdoptionDiagnostic> {
  const { projectPath, config, action, artifact, contract } = input;
  const taskId = action.task?.id;
  if (!taskId || contract.activeTask?.id !== taskId) {
    return adoptionFailure(
      "strict_session_task_mismatch",
      "The canonical action and integration contract do not identify the same active task."
    );
  }

  const contextReads = action.requiredReads.filter((read) => read.role === "context_pack");
  if (contextReads.length !== 1) {
    return adoptionFailure(
      "context_pack_required_read_missing",
      `The canonical action must contain exactly one context_pack required read; found ${contextReads.length}.`
    );
  }
  const contextRead = contextReads[0]!;
  const artifactPath = normalizeArtifactPath(projectPath, artifact.path);
  if (artifactPath === undefined || artifactPath !== contextRead.path) {
    return adoptionFailure(
      "context_pack_path_mismatch",
      `The loaded context pack path does not match the canonical required read ${contextRead.path}.`
    );
  }
  if (`sha256:${artifact.sha256}` !== contextRead.contentHash) {
    return adoptionFailure(
      "context_pack_hash_mismatch",
      "The loaded context pack hash does not match the canonical required read."
    );
  }
  const selectedTask = artifact.pack.selectedTask;
  const actionTaskStatus =
    action.task?.status.state === "available" ? action.task.status.value : undefined;
  if (
    artifact.pack.taskId !== taskId ||
    !isRecord(selectedTask) ||
    selectedTask.id !== taskId ||
    actionTaskStatus === undefined ||
    selectedTask.status !== actionTaskStatus
  ) {
    return adoptionFailure(
      "context_pack_task_mismatch",
      `The context pack and its selected task must match canonical task ${taskId} and its status.`
    );
  }
  const packCommands = artifact.pack.validationCommands ?? [];
  if (!sameStrings(packCommands, action.validationCommands)) {
    return adoptionFailure(
      "context_pack_validation_commands_mismatch",
      "The context pack validation commands do not exactly match the canonical action."
    );
  }

  const filesDiagnostic = await contextFilesFromPack(
    artifact.pack,
    projectPath,
    config.blockedPaths
  );
  if (!filesDiagnostic.ok) {
    return filesDiagnostic;
  }

  const artifactProvenance = action.requiredReads.map((read) => ({
    label: read.id.state === "available" ? read.id.value : read.role,
    path: read.path,
    hash: read.contentHash.slice("sha256:".length),
    hashAlgorithm: "sha256" as const,
    source: "visp-kit" as const
  }));

  return {
    ok: true,
    value: {
      config,
      files: filesDiagnostic.value,
      source: `visp-kit context pack (${taskId})`,
      taskId,
      contextArtifact: {
        path: artifactPath,
        hash: artifact.sha256,
        hashAlgorithm: "sha256"
      },
      artifactProvenance,
      kitReadContract: readContractFromKit(contract, taskId),
      freshnessWarnings: [],
      validationCommands: [...action.validationCommands],
      nextCommand: action.nextCommand,
      warnings: []
    }
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
): Promise<{ ok: true; value: ContextFile[] } | StrictKitAdoptionFailure> {
  const entries = pack.includedFiles ?? pack.files ?? [];
  if (entries.length === 0) {
    return adoptionFailure(
      "context_pack_selected_file_unavailable",
      "The canonical context pack contains no selected files."
    );
  }
  const files: ContextFile[] = [];
  for (const entry of entries) {
    const path = normalizeProjectRelativePath(entry.path);
    if (path === undefined) {
      return adoptionFailure(
        "context_pack_selected_file_invalid",
        `The context pack selected an unsafe project path: ${entry.path}.`
      );
    }
    if (isBlockedPath(path, blockedPaths)) {
      return adoptionFailure(
        "context_pack_selected_file_blocked",
        `The context pack selected a blocked path: ${path}.`
      );
    }
    const provided = entry.content ?? entry.snippet;
    const content = provided ?? (await readPackFile(join(projectPath, path)));
    if (content === undefined && entry.includeMode !== "new-file") {
      return adoptionFailure(
        "context_pack_selected_file_unavailable",
        `The context pack selected ${path}, but its content could not be read.`
      );
    }
    files.push({
      path,
      reason: entry.reason ?? "visp-kit context pack",
      content,
      ...(entry.hash ? { sourceHash: entry.hash, sourceHashAlgorithm: "sha256" as const, sourceHashSource: "visp-kit" as const } : {})
    });
  }
  return { ok: true, value: files };
}

type StrictKitAdoptionFailure = Extract<StrictKitAdoptionDiagnostic, { ok: false }>;

function adoptionFailure(
  reasonCode: StrictKitAdoptionFailure["reasonCode"],
  reason: string
): StrictKitAdoptionFailure {
  return { ok: false, reasonCode, reason };
}

async function readStrictConfigSnapshot(
  projectPath: string
): Promise<{ ok: true; value: HyperConfig } | StrictKitAdoptionFailure> {
  let raw: string;
  try {
    raw = await readFile(vispPath(projectPath, "hyper", "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, value: cloneConfig(defaultConfig) };
    }
    return adoptionFailure(
      "hyper_config_unavailable",
      "The existing Hyper configuration could not be read without modifying the project."
    );
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw) as unknown;
  } catch {
    return adoptionFailure(
      "hyper_config_unavailable",
      "The existing Hyper configuration is not valid JSON."
    );
  }
  const config = parseStrictConfig(candidate);
  return config
    ? { ok: true, value: config }
    : adoptionFailure(
        "hyper_config_unavailable",
        "The existing Hyper configuration does not match the supported schema."
      );
}

function parseStrictConfig(value: unknown): HyperConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const tools: readonly ToolProfile[] = [
    "generic",
    "codex",
    "claude-code",
    "copilot",
    "opencode"
  ];
  if (
    typeof value.defaultTool !== "string" ||
    !tools.includes(value.defaultTool as ToolProfile) ||
    typeof value.tokenBudget !== "number" ||
    !Number.isInteger(value.tokenBudget) ||
    value.tokenBudget <= 0 ||
    (value.memoryMode !== "file" && value.memoryMode !== "llm-memory") ||
    value.contextMode !== "deterministic" ||
    (value.memoryEndpoint !== undefined && typeof value.memoryEndpoint !== "string") ||
    (value.memoryRepoId !== undefined && typeof value.memoryRepoId !== "string") ||
    (value.blockedPaths !== undefined && !isStringArray(value.blockedPaths)) ||
    (value.skillMode !== undefined && value.skillMode !== "auto" && value.skillMode !== "review") ||
    (value.validationCommands !== undefined && !isStringArray(value.validationCommands))
  ) {
    return undefined;
  }
  return {
    defaultTool: value.defaultTool as ToolProfile,
    tokenBudget: value.tokenBudget,
    memoryMode: value.memoryMode,
    memoryEndpoint: value.memoryEndpoint ?? defaultConfig.memoryEndpoint,
    ...(value.memoryRepoId === undefined ? {} : { memoryRepoId: value.memoryRepoId }),
    contextMode: "deterministic",
    blockedPaths: [...(value.blockedPaths ?? defaultConfig.blockedPaths)],
    skillMode: value.skillMode ?? defaultConfig.skillMode,
    ...(value.validationCommands === undefined
      ? {}
      : { validationCommands: [...value.validationCommands] })
  };
}

function cloneConfig(config: HyperConfig): HyperConfig {
  return {
    ...config,
    blockedPaths: [...config.blockedPaths],
    ...(config.validationCommands
      ? { validationCommands: [...config.validationCommands] }
      : {})
  };
}

function normalizeArtifactPath(projectPath: string, path: string): string | undefined {
  return normalizeProjectRelativePath(
    isAbsolute(path) ? relative(projectPath, path) : path
  );
}

function normalizeProjectRelativePath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

async function readPackFile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return content.length > maxContentLength ? `${content.slice(0, maxContentLength)}\n\n[truncated]\n` : content;
  } catch {
    return undefined;
  }
}
