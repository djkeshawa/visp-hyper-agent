// LC-97 — `visp doctor` reported PASS over its own account of the opposite.
//
// The reported run, in full at the top:
//
//     Overall: PASS
//     ...
//     [WARN] Visp Hyper state: Hyper ran 2 work-driving verbs in this project
//     and recorded NO session. ... whatever was built here was not coordinated
//     by Hyper.
//
// Five warnings sat under that PASS. "The work was not coordinated by me" and
// "PASS" cannot both be the answer, and the top line is the one an orchestrator
// reads. This drives the real command end to end and asserts the verdict, the
// exit code and — the other half — that an OPTIONAL capability being absent
// still does not cost the verdict.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../../../src/cli/index.js";
import { initializeProject, recordVerbActivity } from "../../../../src/core/session-manager.js";
import { MEMORY_STORE_MANIFEST } from "../../../../src/memory/visp-memory-install.js";
import { createFakeHostBinaryDir } from "../../../helpers/fake-host-binary.js";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

let projectPath: string;

type DoctorReport = {
  success: boolean;
  verdict: string;
  nextCommand: string;
  checks: Array<{ id: string; status: string; detail: string }>;
};

beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "visp-doctor-verdict-"));
  await execFileAsync("git", ["init"], { cwd: projectPath });
  // No Kit binary and no store, so every finding comes from the project itself
  // rather than from whatever the machine running the suite has installed.
  process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-path-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

async function runDoctorJson(): Promise<{ report: DoctorReport; exitCode: number | undefined }> {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  await runCli(["node", "visp-hyper", "--project", projectPath, "doctor", "--json"]);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { report: JSON.parse(logs.join("")) as DoctorReport, exitCode };
}

async function runDoctorText(): Promise<string> {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void logs.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
  await runCli(["node", "visp-hyper", "--project", projectPath, "doctor"]);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return logs.join("\n");
}

describe("doctor's overall verdict answers for the report under it", () => {
  it("does not say PASS while reporting the work here was never coordinated", async () => {
    await initializeProject(projectPath);
    await recordVerbActivity(projectPath, { verb: "new", outcome: "human-needed" });
    await recordVerbActivity(projectPath, { verb: "plan", outcome: "goal-reached" });

    const { report, exitCode } = await runDoctorJson();

    const state = report.checks.find((check) => check.id === "hyper-state");
    expect(state?.status).toBe("warn");
    expect(state?.detail).toContain("recorded NO session");
    expect(
      report.verdict,
      "the reported defect: `Overall: PASS` printed above `whatever was built here was not " +
        "coordinated by Hyper`"
    ).toBe("inconclusive");
    expect(report.success).toBe(false);
    expect(exitCode, "a caller gating on the exit status must get the same answer as one reading the top line").toBe(1);
  });

  it("prints the verdict a reader sees, not only the one in --json", async () => {
    await initializeProject(projectPath);
    await recordVerbActivity(projectPath, { verb: "new", outcome: "human-needed" });

    const output = await runDoctorText();

    expect(output).toContain("Overall: INCONCLUSIVE");
    expect(output).not.toContain("Overall: PASS");
  });

  it("still passes a project that has done nothing yet, which is not the same thing", async () => {
    // `checkHyperInitialized` already distinguished these two; the verdict has
    // to as well, or a freshly set-up project is inconclusive forever and the
    // word stops carrying information.
    await initializeProject(projectPath);

    const { report, exitCode } = await runDoctorJson();

    expect(report.checks.find((check) => check.id === "hyper-state")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "context-freshness")?.status).toBe("pass");
    expect(report.verdict).toBe("pass");
    expect(exitCode).toBeUndefined();
  });

  it("does not let an optional capability's absence move the verdict", async () => {
    // Memory is optional (D-118). LC-93 made doctor warn when a project holds a
    // visp-memory store the bridge is switched off from — a real contradiction
    // about a capability, and no reason to withhold a verdict on the project.
    await initializeProject(projectPath);
    const before = (await runDoctorJson()).report.verdict;

    process.env.PATH = await createFakeHostBinaryDir("visp-memory", "0.5.0");
    await mkdir(join(projectPath, ".visp"), { recursive: true });
    await writeFile(join(projectPath, MEMORY_STORE_MANIFEST), "version: 1\n", "utf8");

    const { report } = await runDoctorJson();

    expect(
      report.checks.find((check) => check.id === "memory")?.status,
      "LC-93's warning has to still fire, or this test proves nothing"
    ).toBe("warn");
    expect(report.verdict, "an advisory warning must not change the verdict").toBe(before);
  });
});
