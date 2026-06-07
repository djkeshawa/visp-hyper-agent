import type { Command } from "commander";
import { resolve } from "node:path";

export function resolveProjectPath(command: Command): string {
  const options = command.optsWithGlobals<{ project: string }>();
  return resolve(options.project);
}

