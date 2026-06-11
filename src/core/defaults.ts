import type { HyperConfig } from "./types.js";

export const defaultConfig: HyperConfig = {
  defaultTool: "generic",
  tokenBudget: 12000,
  memoryMode: "file",
  memoryEndpoint: "http://localhost:8000",
  contextMode: "deterministic",
  blockedPaths: [".env", ".env.*", "node_modules", "dist", "build", ".git"],
  skillMode: "auto"
};

