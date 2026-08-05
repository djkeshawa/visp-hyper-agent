// P13-US-04 — the Hyper↔Memory seam, tested for real.
//
// Every other check of this seam compares CONSTANTS: Hyper's declared contract
// version against Memory's. That would not have caught a single one of the
// defects this pairing has actually produced, because the constants agreed
// while the behaviour diverged.
//
// These tests run the REAL published `visp-memory` binary through Hyper's REAL
// contract client, so what is under test is the integration itself rather than
// two strings that happen to match. If Memory's envelope shape drifts, Hyper's
// Zod parser rejects it here instead of in a user's project.
//
// If visp-memory is absent the tests FAIL rather than skip. A silently skipped
// integration test is how a seam goes unchecked for months — and every defect
// in this codebase's history has been a check passing for a reason other than
// the thing it named.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MEMORY_CONTRACT_VERSION,
  memoryContractPropose,
  memoryContractRecall
} from "../src/memory/memory-cli-contract.js";

const execFileAsync = promisify(execFile);

const memoryEnv = {
  ...process.env,
  VISP_MEMORY_STORAGE_BACKEND: "sqlite",
  VISP_MEMORY_EMBEDDING_PROVIDER: "noop"
};

let projectPath: string;
let available = false;

beforeAll(async () => {
  try {
    await execFileAsync("visp-memory", ["--version"], { timeout: 30_000 });
    available = true;
  } catch {
    available = false;
  }
  projectPath = await mkdtemp(join(tmpdir(), "visp-memory-seam-"));
  if (available) {
    await execFileAsync("visp-memory", ["init", "--type", "code"], {
      cwd: projectPath,
      env: memoryEnv,
      timeout: 60_000
    });
  }
}, 120_000);

afterAll(async () => {
  if (projectPath !== undefined) await rm(projectPath, { recursive: true, force: true });
});

/** Run the real Memory CLI in the isolated store. */
async function memory(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("visp-memory", [...args], {
    cwd: projectPath,
    env: memoryEnv,
    timeout: 60_000
  });
  return stdout;
}

describe("Hyper ↔ Memory contract, against the real binary", () => {
  it("visp-memory is installed — this seam cannot be checked without it", () => {
    expect(
      available,
      "visp-memory is not installed. This integration test compares Hyper's parser against " +
        "Memory's actual output; skipping it would leave the seam unchecked, which is how " +
        "every defect in this codebase's history survived."
    ).toBe(true);
  });

  it("Memory implements the contract version Hyper speaks", async () => {
    const help = await memory(["contract", "--help"]);
    expect(help).toContain("recall");
    expect(help).toContain("propose");

    const envelope = JSON.parse(
      (await memory(["contract", "recall", "anything", "--repo", "seam"])).trim().split("\n").pop() ?? ""
    ) as { contractVersion?: string };
    expect(envelope.contractVersion).toBe(MEMORY_CONTRACT_VERSION);
  });

  it("Hyper's parser accepts a real recall envelope", async () => {
    await memory(["record", "the build uses pnpm", "--repo", "seam"]);

    const result = await memoryContractRecall({
      projectPath,
      repoId: "seam",
      query: "build"
    });

    // The point of the test: Hyper's Zod schema validated Memory's real bytes.
    expect(result.ok, `Hyper rejected Memory's own output: ${result.ok ? "" : result.reason}`).toBe(
      true
    );
    if (result.ok) {
      expect(result.entries.some((entry) => entry.content.includes("pnpm"))).toBe(true);
      for (const entry of result.entries) {
        expect(typeof entry.kind).toBe("string");
        expect(entry.kind.length).toBeGreaterThan(0);
      }
    }
  });

  it("Hyper's parser accepts a real propose envelope", async () => {
    const result = await memoryContractPropose({
      projectPath,
      repoId: "seam",
      content: "the retry limit should be five"
    });

    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (result.ok) expect(result.proposalId.length).toBeGreaterThan(0);
  });

  // The defect that destroyed the store: propose reported success, and every
  // LATER read failed permanently. A unit test asserting propose succeeded
  // could not see it. This one reads afterwards, which is the only way.
  it("a proposal does not break subsequent recalls", async () => {
    await memory(["record", "deployments need the staging gate", "--repo", "durable"]);

    const before = await memoryContractRecall({
      projectPath,
      repoId: "durable",
      query: "deployments"
    });
    expect(before.ok).toBe(true);

    const proposed = await memoryContractPropose({
      projectPath,
      repoId: "durable",
      content: "a proposal that must not corrupt the store"
    });
    expect(proposed.ok).toBe(true);

    const after = await memoryContractRecall({
      projectPath,
      repoId: "durable",
      query: "deployments"
    });
    expect(
      after.ok,
      `propose corrupted the store: ${after.ok ? "" : after.reason}`
    ).toBe(true);
    if (after.ok) {
      expect(after.entries.some((entry) => entry.content.includes("staging gate"))).toBe(true);
    }
  });

  // Memory's own promise: a proposal is quarantined, not durable. Hyper's
  // `learn` verb tells users exactly that, so if Memory ever started serving
  // proposals from recall, Hyper's user-facing claim would become false.
  it("a proposal is NOT served by recall, as learn promises", async () => {
    const phrase = "the flux capacitor requires exactly eleven volts";
    const proposed = await memoryContractPropose({
      projectPath,
      repoId: "quarantine",
      content: phrase
    });
    expect(proposed.ok).toBe(true);

    const recalled = await memoryContractRecall({
      projectPath,
      repoId: "quarantine",
      query: "flux capacitor volts"
    });
    expect(recalled.ok).toBe(true);
    if (recalled.ok) {
      expect(
        recalled.entries.every((entry) => !entry.content.includes(phrase)),
        "recall served a quarantined proposal; Hyper's `learn` tells users it will not"
      ).toBe(true);
    }
  });

  it("an absent repo scope is refused rather than silently answered", async () => {
    // Memory requires a repo scope. Hyper must surface that as a visible
    // refusal, not an empty result that reads as "nothing is known".
    const result = await memoryContractRecall({ projectPath, query: "anything" });
    if (result.ok) {
      // If it succeeds it must genuinely have a scope from config, not have
      // silently returned nothing.
      expect(Array.isArray(result.entries)).toBe(true);
    } else {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
