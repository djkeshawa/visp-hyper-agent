import type { KitTask } from "../kit/kit-schemas.js";

export type ToolProfile = "generic" | "codex" | "claude-code" | "copilot" | "opencode";

export type HyperConfig = {
  defaultTool: ToolProfile;
  tokenBudget: number;
  memoryMode: "file" | "llm-memory";
  memoryEndpoint: string;
  contextMode: "deterministic";
  blockedPaths: string[];
  skillMode: "auto" | "review";
};

export type HyperState = {
  activeSessionId: string | null;
  sessions: Record<string, SessionRecord>;
};

export type PipelineStepRecord = {
  taskId: string;
  action: "started" | "checkpoint-passed" | "checkpoint-failed";
  at: string;
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
  workflow: string[];
  hardRules: string[];
  integrationSeams: IntegrationSeam[];
  nextInstruction: string;
  completionInstruction: string;
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
};

export type ContextPackOptions = {
  source?: string;
  validationCommands?: string[];
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

export interface ValidationCommandRunner {
  detect(projectPath: string): Promise<string[]>;
  run(projectPath: string, commands: string[]): Promise<Array<{ command: string; exitCode: number; output: string }>>;
}

export interface BranchSessionLocator {
  currentBranch(projectPath: string): Promise<string | null>;
  sessionKey(projectPath: string, branch: string | null): string;
}

export interface McpBridge {
  listTools(): Promise<Array<{ name: string; description: string }>>;
}
