/**
 * Running one tool call.
 *
 * Each call is a CLI command run in-process with its console output captured.
 * Because that capture patches the global console, calls are serialized: two
 * concurrent tools would otherwise write into each other's buffer.
 */

import { runCli } from "../../cli/index.js";
import { SPEC_BY_NAME } from "./tool-specs.js";
import type { ToolArgs } from "./arg-guards.js";

/**
 * Serializes tool executions so that the temporary console patching done by one
 * tool call never bleeds into a concurrent one. Each execution chains onto the
 * previous regardless of outcome.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run a CLI command in-process with all console output captured into a text
 * buffer. stdout/stderr of the host process are untouched (the MCP loop owns
 * stdout); console.* is redirected only for the duration of the command.
 */
export async function executeTool(
  projectPath: string,
  name: string,
  args: ToolArgs
): Promise<{ text: string; isError: boolean }> {
  const spec = SPEC_BY_NAME.get(name);
  if (!spec) {
    return { text: `invalid arguments: unknown tool ${name}`, isError: true };
  }

  const validationError = spec.validate(args);
  if (validationError) {
    return { text: `invalid arguments: ${validationError}`, isError: true };
  }

  const run = async (): Promise<{ text: string; isError: boolean }> => {
    const argv = ["node", "visp-hyper", "--project", projectPath, ...spec.toArgv(args)];
    const lines: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const previousExitCode = process.exitCode;

    const capture = (...parts: unknown[]): void => {
      lines.push(parts.map((part) => String(part)).join(" "));
    };

    let isError = false;
    process.exitCode = undefined;
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await runCli(argv);
    } catch (err) {
      lines.push(err instanceof Error ? err.message : String(err));
      isError = true;
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
      const capturedExit = process.exitCode;
      isError = isError || (capturedExit !== undefined && capturedExit !== 0);
      process.exitCode = previousExitCode;
    }

    return { text: lines.join("\n"), isError };
  };

  const pending = queue.then(run, run);
  // Keep the chain alive but never let a rejection poison later executions.
  queue = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}
