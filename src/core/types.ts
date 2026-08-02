import type { KitTask } from "../kit/kit-schemas.js";

export type ToolProfile = "generic" | "codex" | "claude-code" | "copilot" | "opencode";

export type HyperConfig = {
  defaultTool: ToolProfile;
  tokenBudget: number;
  memoryMode: "file" | "llm-memory";
  memoryEndpoint: string;
  memoryRepoId?: string;
  contextMode: "deterministic";
  blockedPaths: string[];
  skillMode: "auto" | "review";
  /**
   * Extra validation commands merged into the detected allowlist (e.g.
   * "pnpm run lint"). Config-provided, so the no-shell-interpolation rule
   * holds: they run via execFile argument arrays like detected commands.
   */
  validationCommands?: string[];
  /**
   * P10-US-03: which Kit binary the bridge spawns. Unset means auto-resolve
   * (VISP_KIT_BINARY env, then probe visp-kit, then fall back to visp).
   */
  kitBinary?: string;
};

export type HyperState = {
  activeSessionId: string | null;
  sessions: Record<string, SessionRecord>;
  /**
   * Active session per BranchSessionLocator key, so parallel branches or
   * worktrees each resume their own session. Optional: legacy state files
   * without it keep parsing, and resolution falls back to activeSessionId.
   */
  activeSessionByBranch?: Record<string, string>;
};

export type PipelineStepRecord = {
  taskId: string;
  action: "started" | "checkpoint-passed" | "checkpoint-failed" | "task-injected" | "escalation-issued";
  at: string;
  detail?: string;
  /**
   * Stable hash of the findings that failed this checkpoint (P8-03). Present
   * only on `checkpoint-failed`, and only when findings were supplied.
   *
   * It exists so a retry can be refused when nothing has changed: the same
   * failure seen twice escalates rather than being attempted again. Absent on
   * records written before P8-03, which is why an unknown history falls back to
   * the count-based bound rather than guessing.
   */
  failureFingerprint?: string;
};

/**
 * Audit record for a deterministic adaptive decision (remediation injection or
 * escalation directive) taken after a failed checkpoint.
 */
export type AdaptiveDecisionRecord = {
  at: string;
  taskId: string;
  rule: string;
  action: "inject-remediation" | "escalation-directive";
  detail?: string;
};

export type PipelineState = {
  taskIds: string[];
  currentTaskId: string | null;
  completed: string[];
  stepHistory: PipelineStepRecord[];
  /**
   * Synthetic task definitions for pipelines that exist nowhere on disk (e.g. the
   * one-task graph fabricated by `visp-hyper quick`). When present, `checkpoint`
   * resolves the task graph from these entries instead of `loadTaskGraph`.
   */
  syntheticTasks?: KitTask[];
  /**
   * Remediation tasks injected by adaptive rules after repeated checkpoint
   * failures. Like syntheticTasks they exist nowhere on disk; effectiveGraph
   * merges them into the graph in-memory. Optional for legacy state files.
   */
  injectedTasks?: KitTask[];
  /** Audit trail of adaptive decisions. Optional for legacy state files. */
  decisionLog?: AdaptiveDecisionRecord[];
};

export type SessionRecord = {
  id: string;
  goal: string;
  tool: ToolProfile;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  phase: "initialized" | "implementation" | "review" | "remembered";
  relevantFiles: string[];
  pipeline?: PipelineState;
};

export type HandoffProtocol = {
  version: "0.1";
  sessionId: string;
  goal: string;
  phase: SessionRecord["phase"];
  toolProfile: ToolProfile;
  toolProfileLabel: string;
  profileInstructions: string[];
  requiredReads: string[];
  requiredResources: HandoffResource[];
  workflow: string[];
  hardRules: string[];
  integrationSeams: IntegrationSeam[];
  nextInstruction: string;
  completionInstruction: string;
};

export type HandoffResource = {
  path?: string;
  uri: string;
  title: string;
  mimeType: string;
  source: "file" | "computed";
};

export type IntegrationSeam = {
  id: string;
  capability: string;
  status: "typed-seam";
  notes: string;
};

export type KitArtifacts = {
  constitution?: ArtifactFile;
  rules: ArtifactFile[];
  specs: ArtifactFile[];
  tasks: ArtifactFile[];
  plans: ArtifactFile[];
  warnings: string[];
};

export type ArtifactFile = {
  path: string;
  content: string;
  summary: string;
};

export type MemoryPack = {
  files: ArtifactFile[];
  warnings: string[];
};

export type ContextFile = {
  path: string;
  reason: string;
  content?: string;
  sourceHash?: string;
  sourceHashAlgorithm?: "sha256";
  sourceHashSource?: "visp-kit";
};

export type ContextPackOptions = {
  source?: string;
  validationCommands?: string[];
};

export type ContextManifest = {
  version: "0.1";
  sessionId: string;
  goal: string;
  toolProfile: ToolProfile;
  generatedAt: string;
  contextSource: string;
  taskId?: string;
  contextArtifact?: {
    path: string;
    hash: string;
    hashAlgorithm: "sha256";
  };
  artifactProvenance?: Array<{
    label: string;
    path: string;
    hash: string;
    hashAlgorithm: "sha256";
    source: "visp-kit";
  }>;
  freshnessWarnings?: string[];
  kitReadContract?: {
    contractVersion: string;
    readContractVersion: string;
    requiredArtifacts: Array<{
      id: string;
      path: string;
      role: string;
      mimeType: string;
      requiredFor: string[];
      freshness: string;
    }>;
    freshnessPolicy?: {
      contextPackHashPinned?: boolean;
      provenanceArtifactsHashPinned?: boolean;
      staleContextBlocks: string[];
    };
  };
  requiredReads: string[];
  requiredResources: HandoffResource[];
  selectedFiles: Array<{
    path: string;
    reason: string;
    hasContent: boolean;
    sourceHash?: string;
    sourceHashAlgorithm?: "sha256";
    sourceHashSource?: "visp-kit";
  }>;
  validationCommands: string[];
  blockedPaths: string[];
  failurePatterns: Array<{
    id: string;
    taskId: string;
    taskClass: string;
    source: "kit" | "local";
    occurrences: number;
    relatedFiles: string[];
    findings: string[];
  }>;
  nextCommand: string;
};

export type RecallOptions = {
  limit?: number;
  filters?: Record<string, string>;
};

export type MemoryResult = {
  path: string;
  content: string;
  summary: string;
};

export type MemoryRecord = {
  sessionId: string;
  goal: string;
  summary: string;
  timestamp?: string;
  changedFiles?: string[];
  reviewSummary?: string;
  decisions?: string[];
  followUps?: string[];
};

export type DecisionRecord = {
  title: string;
  decision: string;
  timestamp?: string;
};

export type ProjectMemoryProfile = {
  projectPath: string;
  summary: string;
};

export interface MemoryProvider {
  recall(query: string, options?: RecallOptions): Promise<MemoryResult[]>;
  remember(record: MemoryRecord): Promise<void>;
  storeDecision(decision: DecisionRecord): Promise<void>;
  getProjectProfile(projectPath: string): Promise<ProjectMemoryProfile | null>;
}

export interface SemanticMemoryProvider extends MemoryProvider {
  semanticRecall(query: string, options?: RecallOptions): Promise<MemoryResult[]>;
}

/**
 * Result of running one validation command. `exitCode` is `null` when the
 * command could not be spawned at all (missing binary / EINVAL); in that case
 * `spawnError` carries the reason. A `null` exit code is NOT a passing result —
 * consumers must fail closed — but it is distinct from a real non-zero exit so
 * evidence can honestly say "command could not be run" vs "verify failed".
 */
export interface ValidationResult {
  command: string;
  exitCode: number | null;
  output: string;
  spawnError?: string;
}

export type EvidenceVerdict = "passed" | "failed" | "inconclusive";
export type AssuranceLevel = "kit_strict" | "local_checked" | "advisory";

export interface ValidationCommandRunner {
  detect(projectPath: string): Promise<string[]>;
  run(projectPath: string, commands: string[]): Promise<ValidationResult[]>;
}

export interface BranchSessionLocator {
  currentBranch(projectPath: string): Promise<string | null>;
  sessionKey(projectPath: string, branch: string | null): string;
}

export interface McpBridge {
  listTools(): Promise<Array<{ name: string; description: string }>>;
}
