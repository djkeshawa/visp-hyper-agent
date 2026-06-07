export type ToolProfile = "generic" | "codex" | "claude-code" | "copilot" | "opencode";

export type HyperConfig = {
  defaultTool: ToolProfile;
  tokenBudget: number;
  memoryMode: "file";
  contextMode: "deterministic";
  blockedPaths: string[];
};

export type HyperState = {
  activeSessionId: string | null;
  sessions: Record<string, SessionRecord>;
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
};

export type HandoffProtocol = {
  version: "0.1";
  sessionId: string;
  goal: string;
  phase: SessionRecord["phase"];
  toolProfile: ToolProfile;
  requiredReads: string[];
  workflow: string[];
  hardRules: string[];
  nextInstruction: string;
  completionInstruction: string;
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
