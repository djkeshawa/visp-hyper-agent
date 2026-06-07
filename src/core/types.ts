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

export type KitArtifacts = {
  constitution?: string;
  rules: Array<{ path: string; content: string }>;
  specs: Array<{ path: string; content: string }>;
  tasks: Array<{ path: string; content: string }>;
  plans: Array<{ path: string; content: string }>;
};

export type MemoryPack = {
  files: Array<{ path: string; content: string }>;
};

export type ContextFile = {
  path: string;
  reason: string;
  content?: string;
};

