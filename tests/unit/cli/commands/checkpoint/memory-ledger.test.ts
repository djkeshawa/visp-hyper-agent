// LC-26: a memory that was never recorded must never look like one that was.
//
// The absence guard here used to be `resolveExecutable`, which on POSIX returns
// the bare name for anything at all — so the guard never fired, the `record`
// spawn failed, and the user saw `spawn visp-memory ENOENT`. Accidentally loud,
// and no help. Detecting the absence properly is only half a fix: doing it
// without saying so would have replaced a bad message with silence.
//
// So this pins both halves at once — the warning is still printed, and it now
// names what is missing and how to fix it instead of a syscall.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordCompletionMemory } from "../../../../../src/cli/commands/checkpoint/memory-ledger.js";
import { defaultConfig } from "../../../../../src/core/defaults.js";
import { toolOnlyPath } from "../../../../helpers/tool-path.js";

const originalPath = process.env.PATH;

describe("recordCompletionMemory when visp-memory is not installed", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.restoreAllMocks();
  });

  async function projectWithMemoryMode(mode: "file" | "llm-memory"): Promise<string> {
    const projectPath = await mkdtemp(join(tmpdir(), "visp-memory-ledger-"));
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    await writeFile(
      join(projectPath, ".visp", "hyper", "config.json"),
      `${JSON.stringify({ ...defaultConfig, memoryMode: mode }, null, 2)}\n`,
      "utf8"
    );
    return projectPath;
  }

  it("says the CLI is missing and how to install it", async () => {
    const projectPath = await projectWithMemoryMode("llm-memory");
    process.env.PATH = `${await toolOnlyPath(["git"])}${delimiter}`;

    await recordCompletionMemory(projectPath, "T001");
    const output = logs.join("\n");

    expect(output).toContain("warning: memory was not recorded:");
    expect(output).toContain("the visp-memory CLI is not installed on this machine.");
    expect(output).toContain("pip install 'visp-memory[mcp,capture]'");
  });

  it("reports the gap instead of the spawn's ENOENT", async () => {
    const projectPath = await projectWithMemoryMode("llm-memory");
    process.env.PATH = `${await toolOnlyPath(["git"])}${delimiter}`;

    await recordCompletionMemory(projectPath, "T001");
    const output = logs.join("\n");

    // The old path reached the spawn and reported the syscall. Naming the
    // syscall is how we know the guard did not fire.
    expect(output).not.toContain("ENOENT");
    expect(output).not.toContain("remembered:");
  });

  it("stays silent about Memory when the project uses file memory", async () => {
    // Not every quiet return is the defect: file mode records nothing by
    // design, and warning there would be noise on every checkpoint.
    const projectPath = await projectWithMemoryMode("file");
    process.env.PATH = `${await toolOnlyPath(["git"])}${delimiter}`;

    await recordCompletionMemory(projectPath, "T001");

    expect(logs.join("\n")).not.toContain("memory was not recorded");
  });
});
