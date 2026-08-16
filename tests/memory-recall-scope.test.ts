// A4(a): recall was called with a quarter of its inputs.
//
// `Memory.recall()` takes task, files, session, constraints, environment and
// as_of, and feeds all of them to `rank_with_context` (ranking) and
// `filter_recall_eligible` (temporal and scope eligibility). Hyper's contract
// forwarded query, repo and min-score only — while the coordinator was holding
// the task id, the goal, the file scope and the session at the exact moment it
// called. That is a ranking-quality loss on every retrieval.
//
// Two things are pinned here. The scope is forwarded when it is held; and a
// visp-memory too old to accept the flags degrades to today's behaviour with a
// stated reason, never to a hard failure and never to silence.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryContractRecall } from "../src/memory/memory-cli-contract.js";
import { putNodeExecutableOnPath } from "./helpers/fake-executable.js";

const originalPath = process.env.PATH;
let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "vh-recall-scope-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
});

const argvLog = () => join(project, "argv.json");

/** A visp-memory that records its argv and answers with one entry. */
async function stubVispMemory(body: string): Promise<void> {
  await putNodeExecutableOnPath(join(project, "bin"), "visp-memory", body);
}

const recordArgv = (log: string) =>
  `require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`;

const answerOk = `process.stdout.write(JSON.stringify({ contractVersion: "1.0", success: true, entries: [{ kind: "decision", content: "ok" }] }));`;

async function readArgvCalls(): Promise<string[][]> {
  const text = await readFile(argvLog(), "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

describe("the contract forwards the scope the coordinator is holding", () => {
  it("passes task, files, constraints, session and environment through", async () => {
    await stubVispMemory(`${recordArgv(argvLog())}\n${answerOk}`);

    const result = await memoryContractRecall({
      projectPath: project,
      query: "due date",
      scope: {
        task: "Extend addTodo to accept an optional due date",
        files: ["src/store.js", "tests/store.test.js"],
        constraints: ["src/legacy/**", "the store must stay synchronous"],
        sessionId: "sess-42",
        environment: ["linux", "node24"],
        asOf: "2026-08-14T00:00:00Z"
      }
    });

    expect(result.ok).toBe(true);
    const argv = (await readArgvCalls())[0] ?? [];
    expect(argv.slice(0, 3)).toEqual(["contract", "recall", "due date"]);
    expect(argv).toContain("--task");
    expect(argv[argv.indexOf("--task") + 1]).toBe("Extend addTodo to accept an optional due date");
    expect(argv.filter((item) => item === "--file")).toHaveLength(2);
    expect(argv).toContain("src/store.js");
    expect(argv.filter((item) => item === "--constraint")).toHaveLength(2);
    expect(argv).toContain("the store must stay synchronous");
    expect(argv[argv.indexOf("--session") + 1]).toBe("sess-42");
    expect(argv.filter((item) => item === "--environment")).toHaveLength(2);
    expect(argv[argv.indexOf("--as-of") + 1]).toBe("2026-08-14T00:00:00Z");
  });

  it("sends nothing extra when no scope is held", async () => {
    await stubVispMemory(`${recordArgv(argvLog())}\n${answerOk}`);

    await memoryContractRecall({ projectPath: project, query: "anything" });

    const argv = (await readArgvCalls())[0] ?? [];
    expect(argv).toEqual(["contract", "recall", "anything", "--json"]);
  });

  it("drops blank and over-long members rather than shipping junk scope", async () => {
    await stubVispMemory(`${recordArgv(argvLog())}\n${answerOk}`);

    await memoryContractRecall({
      projectPath: project,
      query: "q",
      scope: {
        task: "   ",
        files: ["", "  ", "src/a.ts", ...Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`)],
        sessionId: ""
      }
    });

    const argv = (await readArgvCalls())[0] ?? [];
    expect(argv).not.toContain("--task");
    expect(argv).not.toContain("--session");
    // Capped: argv is a process argument list, not a place to stream a repo.
    expect(argv.filter((item) => item === "--file").length).toBeLessThanOrEqual(24);
    expect(argv).toContain("src/a.ts");
  });
});

describe("the working loop actually hands over what it is holding", () => {
  it("forwards the goal, the selected files and the session id from `start`", async () => {
    const { runCli } = await import("../src/cli/index.js");
    const { initializeProject } = await import("../src/core/session-manager.js");
    const { vi } = await import("vitest");

    await writeFile(join(project, "README.md"), "# Demo\n\nOffline note sync CLI.\n", "utf8");
    await writeFile(join(project, "package.json"), '{"name":"demo"}\n', "utf8");
    await initializeProject(project);
    await writeFile(
      join(project, ".visp", "hyper", "config.json"),
      JSON.stringify({
        defaultTool: "generic",
        tokenBudget: 12000,
        contextMode: "deterministic",
        blockedPaths: [".git"],
        memoryMode: "llm-memory",
        memoryEndpoint: "http://127.0.0.1:1"
      }),
      "utf8"
    );
    await stubVispMemory(`${recordArgv(argvLog())}\n${answerOk}`);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runCli(["node", "visp-hyper", "--project", project, "start", "implement offline note sync"]);
    vi.restoreAllMocks();

    const argv = (await readArgvCalls())[0] ?? [];
    expect(argv[argv.indexOf("--task") + 1]).toBe("implement offline note sync");
    // The relevance scanner picked these; recall now knows what the task touches.
    expect(argv).toContain("--file");
    expect(argv).toContain("README.md");
    expect(argv).toContain("--session");
    expect(argv[argv.indexOf("--session") + 1]).toMatch(/\S/u);
    expect(argv).toContain("--environment");
  });
});

describe("an older visp-memory degrades visibly, never silently", () => {
  it("retries without the scope and reports the degradation", async () => {
    // click/typer answer an unknown option with exit code 2 and a usage error.
    await stubVispMemory(
      `${recordArgv(argvLog())}
if (process.argv.includes("--task")) {
  process.stderr.write("Error: No such option: --task\\n");
  process.exit(2);
}
${answerOk}`
    );

    const result = await memoryContractRecall({
      projectPath: project,
      query: "due date",
      scope: { task: "add a due date", files: ["src/store.js"] }
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.entries).toHaveLength(1);
    // The recall still worked, but the caller must be able to say why it was
    // ranked without context.
    expect(result.ok && result.degraded).toMatch(/scope/i);
    expect(result.ok && result.degraded).toMatch(/upgrade|older|does not accept/i);

    const calls = await readArgvCalls();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["contract", "recall", "due date", "--json"]);
  });

  it("does not retry a genuine failure as if it were a usage error", async () => {
    await stubVispMemory(
      `${recordArgv(argvLog())}
process.stderr.write("boom\\n");
process.exit(1);`
    );

    const result = await memoryContractRecall({
      projectPath: project,
      query: "q",
      scope: { task: "t" }
    });

    expect(result.ok).toBe(false);
    expect(await readArgvCalls()).toHaveLength(1);
  });
});
