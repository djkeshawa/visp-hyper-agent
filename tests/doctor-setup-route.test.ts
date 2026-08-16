// LC-9 — doctor may not send a user into a command it knows cannot run.
//
// On a clean project doctor reported FAIL and said "Run `visp setup`". Setup
// then said the Visp Dev machine-scope adapter was not installed. A user with
// no adapter had nowhere left to go, and the route that would have worked —
// `visp-kit init .` — was named by no verb doctor pointed at.
//
// Doctor can tell the difference: it may load the adapter, and loading it is
// the only honest test of whether setup has a machine scope to run. So the
// property is that its recommendation follows that answer, in both directions.
//
// The adapter probe is stubbed rather than driven, because the outcome under
// test is what doctor SAYS about a machine, and the real answer depends on
// whatever happens to be installed on the machine running the suite.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MACHINE_SCOPE_ROUTE, PROJECT_SCOPE_ROUTE } from "../src/cli/commands/doctor/setup-route.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "visp-doctor-route-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  await rm(tempDir, { recursive: true, force: true });
});

/** Run doctor over an uninitialised project with the adapter probe stubbed. */
async function doctorOn(machineScope: "available" | "unavailable") {
  vi.resetModules();
  vi.doMock("../src/cli/machine/machine-scope.js", () => ({
    machineScopeAvailable: async () => machineScope === "available"
  }));

  const { runDoctor } = await import("../src/cli/commands/doctor.js");
  return runDoctor(tempDir);
}

function recoveryFor(summary: { checks: readonly { id: string; recovery?: string }[] }, id: string) {
  return summary.checks.find((check) => check.id === id)?.recovery;
}

describe("doctor's next step on an uninitialised project", () => {
  it("names the project-scope route when no machine-scope adapter is installed", async () => {
    const summary = await doctorOn("unavailable");

    expect(
      summary.nextCommand,
      "doctor sent the user to `visp setup` on a machine where setup cannot run. That is the " +
        "closed loop LC-9 reports: doctor says setup, setup says install, install is already done."
    ).toBe(PROJECT_SCOPE_ROUTE);
    expect(summary.nextCommand).toContain("visp-kit init .");
  });

  it("still names setup when the adapter is there to run", async () => {
    const summary = await doctorOn("available");

    expect(
      summary.nextCommand,
      "setup is the right answer whenever it can actually run; the project-scope route is the " +
        "fallback, not the replacement."
    ).toBe(MACHINE_SCOPE_ROUTE);
  });

  it("gives the state and artifact checks the same route, so the report does not contradict itself", async () => {
    const summary = await doctorOn("unavailable");

    expect(recoveryFor(summary, "hyper-state")).toBe(PROJECT_SCOPE_ROUTE);
    expect(recoveryFor(summary, "kit-artifacts")).toBe(PROJECT_SCOPE_ROUTE);
  });

  it("names the Hyper step as well as Kit's, because Kit's alone does not clear the check", async () => {
    // Assay followed this route rather than reading it. `visp-kit init .` sets
    // up Kit and reports success; `visp doctor` then still says "Visp Hyper has
    // not been initialized in this project" and recommends `visp-kit init .`
    // again — forever, because Kit artifacts existing never satisfies the Hyper
    // state check that generates this route. That is LC-9's defect verbatim,
    // reintroduced on the project-scope side by the fix for the machine-scope
    // side. `visp init` is what finishes the job.
    const summary = await doctorOn("unavailable");

    expect(summary.nextCommand).toContain("visp-kit init .");
    expect(
      summary.nextCommand,
      "the route stops at Kit, so a user who follows it lands back on the same advice with " +
        "nothing changed — a loop, not a route"
    ).toContain("visp init");
  });

  it("does not repeat itself once Kit's step is done", async () => {
    // The state after `visp-kit init .`: Kit artifacts present, Hyper still
    // uninitialised. The advice must have moved on.
    await mkdir(join(tempDir, ".visp"), { recursive: true });
    await writeFile(join(tempDir, ".visp", "policy.json"), "{}\n", "utf8");

    const summary = await doctorOn("unavailable");

    expect(recoveryFor(summary, "hyper-state")).toContain("visp init");
    expect(summary.checks.find((check) => check.id === "kit-artifacts")?.status).toBe("pass");
  });

  it("says why setup is unavailable, not merely that something else should be run", async () => {
    // A redirect with no reason reads as arbitrary, and the user has already
    // been told once that the thing they installed is missing.
    const summary = await doctorOn("unavailable");

    expect(summary.nextCommand).toMatch(/machine-scope adapter/u);
  });
});
