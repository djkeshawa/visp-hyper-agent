// LC-179 — when visp-memory refuses, say what it said.
//
// A contract command that fails prints a failure envelope on stdout — for
// example "recall failed: Storage writer conflict … set storage.mode: client"
// when a local visp-memory server owns the store — and exits 1. Hyper read
// only the exit status and reported "visp-memory did not answer: Command
// failed: …", which names neither the cause nor the remedy Memory had already
// written down. The answer was there; Hyper threw it away.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runRecallVerb } from "../../../../src/cli/memory/memory-verbs.js";
import { initializeProject } from "../../../../src/core/session-manager.js";
import {
  memoryContractPropose,
  memoryContractRecall
} from "../../../../src/memory/memory-cli-contract.js";
import { MEMORY_STORE_MANIFEST } from "../../../../src/memory/visp-memory-install.js";
import { putNodeExecutableOnPath } from "../../../helpers/fake-executable.js";

const WRITER_CONFLICT =
  "recall failed: Storage writer conflict for /store: held by pid 4242; " +
  "set storage.mode: client in .visp-memory.yaml to use the running server";

const originalPath = process.env.PATH;
let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "vh-contract-failure-"));
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.exitCode = 0;
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
});

const argvLog = () => join(project, "argv.json");

const recordArgv = () =>
  `require("node:fs").appendFileSync(${JSON.stringify(argvLog())}, JSON.stringify(process.argv.slice(2)) + "\\n");`;

/** A visp-memory that refuses the way the real one does: envelope on stdout, exit 1. */
const refuseWith = (reason: string) =>
  `process.stdout.write(JSON.stringify({ contractVersion: "1.0", success: false, reason: ${JSON.stringify(reason)} }) + "\\n");
process.exit(1);`;

async function stubVispMemory(body: string): Promise<void> {
  await putNodeExecutableOnPath(join(project, "bin"), "visp-memory", `${recordArgv()}\n${body}`);
}

async function callCount(): Promise<number> {
  const text = await readFile(argvLog(), "utf8");
  return text.split("\n").filter((line) => line.length > 0).length;
}

describe("a refusing visp-memory is quoted, not paraphrased", () => {
  it("surfaces the recall failure reason visp-memory printed", async () => {
    await stubVispMemory(refuseWith(WRITER_CONFLICT));

    const result = await memoryContractRecall({ projectPath: project, query: "why jwt" });

    expect(result).toEqual({ ok: false, reason: `visp-memory refused: ${WRITER_CONFLICT}` });
  });

  it("surfaces the propose failure reason visp-memory printed", async () => {
    await stubVispMemory(refuseWith("propose failed: Storage writer conflict"));

    const result = await memoryContractPropose({ projectPath: project, content: "a lesson" });

    expect(result).toEqual({
      ok: false,
      reason: "visp-memory refused: propose failed: Storage writer conflict"
    });
  });

  it("prints the reason from `visp recall`, remedy included", async () => {
    await writeFile(join(project, MEMORY_STORE_MANIFEST), "repo_id: demo\n", "utf8");
    await initializeProject(project, true);
    const configPath = join(project, ".visp", "hyper", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeFile(configPath, JSON.stringify({ ...config, memoryMode: "llm-memory" }), "utf8");
    await stubVispMemory(refuseWith(WRITER_CONFLICT));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void errors.push(args.join(" ")));

    await runRecallVerb(project, "why jwt");

    expect(errors.join("\n")).toContain(`visp recall: visp-memory refused: ${WRITER_CONFLICT}`);
    expect(errors.join("\n")).not.toContain("Command failed");
    expect(process.exitCode).toBe(1);
  });

  it("does not echo hostile bytes from stdout into the terminal", async () => {
    await stubVispMemory(refuseWith(`\u001b[2Jrecall failed:\u0007 ${"x".repeat(5000)}`));

    const result = await memoryContractRecall({ projectPath: project, query: "q" });

    expect(result.ok).toBe(false);
    const reason = result.ok ? "" : result.reason;
    expect(reason.startsWith("visp-memory refused: recall failed: x")).toBe(true);
    expect(reason).not.toMatch(/\p{Cc}/u);
    expect(reason.length).toBeLessThan(1000);
  });
});

describe("a failure without an envelope keeps the old report", () => {
  it("reports 'did not answer' when stdout is not JSON", async () => {
    await stubVispMemory(`process.stdout.write("Traceback: boom\\n"); process.exit(1);`);

    const result = await memoryContractRecall({ projectPath: project, query: "q" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/^visp-memory did not answer: /u);
  });

  it("reports 'did not answer' when stdout is JSON of the wrong shape", async () => {
    await stubVispMemory(
      `process.stdout.write(JSON.stringify({ success: true, reason: "not a refusal" })); process.exit(1);`
    );

    const result = await memoryContractPropose({ projectPath: project, content: "c" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/^visp-memory did not answer: /u);
    expect(result.ok ? "" : result.reason).not.toContain("not a refusal");
  });

  it("still names the missing command when visp-memory is not on PATH", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "vh-no-memory-"));

    const result = await memoryContractRecall({ projectPath: project, query: "q" });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("visp-memory is not installed");
  });
});

describe("a usage error is still retried without the scope", () => {
  it("retries on exit 2, then quotes the retry's refusal", async () => {
    await stubVispMemory(`if (process.argv.includes("--task")) {
  process.stderr.write("Error: No such option: --task\\n");
  process.exit(2);
}
${refuseWith(WRITER_CONFLICT)}`);

    const result = await memoryContractRecall({
      projectPath: project,
      query: "q",
      scope: { task: "t" }
    });

    expect(await callCount()).toBe(2);
    expect(result).toEqual({ ok: false, reason: `visp-memory refused: ${WRITER_CONFLICT}` });
  });
});
