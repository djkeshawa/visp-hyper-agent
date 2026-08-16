// P10-US-03: the bridge release. Binary resolution (env → config →
// visp-kit probe → visp fallback), the self-invocation guard, dual CLI
// identity in negotiation, and 3.4 verification with the wording-invariance
// guarantee the projection exists to provide.

import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSelfInvocation, resolveKitBinary } from "../../../src/kit/kit-binary-resolver.js";
import {
  createWorkflowActionV34Id,
  normalizeWorkflowAction
} from "../../../src/kit/workflow-action-adapter.js";
import {
  TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES,
  selectWorkflowActionProtocol,
  workflowActionV34StrictSchema,
  type WorkflowActionProtocolSelection
} from "../../../src/kit/workflow-action-protocol.js";
import { workflowActionV34Fixture } from "../../helpers/canonical-action-fixture.js";

const originalPath = process.env.PATH;
const originalKitBinary = process.env.VISP_KIT_BINARY;

async function writeExecutable(filePath: string): Promise<void> {
  await writeFile(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(filePath, 0o755);
}

describe("resolveKitBinary", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "visp-binres-"));
    delete process.env.VISP_KIT_BINARY;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalKitBinary === undefined) {
      delete process.env.VISP_KIT_BINARY;
    } else {
      process.env.VISP_KIT_BINARY = originalKitBinary;
    }
  });

  it("prefers visp-kit on PATH over the visp fallback", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(join(binDir, "visp-kit"));
    await writeExecutable(join(binDir, "visp"));
    process.env.PATH = binDir;

    const resolution = await resolveKitBinary({});
    expect(resolution).toEqual({ ok: true, binary: "visp-kit", source: "probe", found: true });
  });

  it("falls back to visp when visp-kit is absent", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(join(binDir, "visp"));
    process.env.PATH = binDir;

    const resolution = await resolveKitBinary({});
    expect(resolution).toEqual({ ok: true, binary: "visp", source: "fallback", found: true });
  });

  it("VISP_KIT_BINARY overrides everything", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await writeExecutable(join(binDir, "visp-kit"));
    process.env.PATH = binDir;
    process.env.VISP_KIT_BINARY = join(binDir, "visp-kit");

    const resolution = await resolveKitBinary({});
    expect(resolution).toMatchObject({ ok: true, source: "env" });
  });

  it("reads kitBinary from .visp/hyper/config.json", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    const custom = join(binDir, "my-kit");
    await writeExecutable(custom);
    process.env.PATH = binDir;
    const projectPath = join(tempDir, "project");
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    await writeFile(
      join(projectPath, ".visp", "hyper", "config.json"),
      JSON.stringify({ kitBinary: custom }),
      "utf8"
    );

    const resolution = await resolveKitBinary({ projectPath });
    expect(resolution).toEqual({ ok: true, binary: custom, source: "config", found: true });
  });

  // The trap the guard exists for: once `visp` is Hyper's own binary, an old
  // bridge spawning `visp` spawns itself. That must be a clean named failure,
  // never a schema-parse surprise.
  it("refuses a visp fallback that resolves into visp-hyper-agent itself", async () => {
    const packageBin = join(tempDir, "node_modules", "visp-hyper-agent", "dist");
    await mkdir(packageBin, { recursive: true });
    const realBinary = join(packageBin, "index.js");
    await writeExecutable(realBinary);
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await symlink(realBinary, join(binDir, "visp"));
    process.env.PATH = binDir;

    expect(await isSelfInvocation("visp")).toBe(true);
    const resolution = await resolveKitBinary({});
    expect(resolution).toMatchObject({ ok: false, reasonCode: "self_invocation" });
    if (!resolution.ok) {
      expect(resolution.reason).toContain("visp-hyper-agent itself");
    }
  });

  // P12: the resolver returns ok:true with a GUESSED `visp` when nothing is
  // installed. Treating that as evidence an engine exists is what sent a
  // Kit-less user to `visp-kit init` and a command-not-found. `found` is the
  // field that separates located from guessed, and these pin it.
  it("reports found:false when nothing is installed and visp is only a guess", async () => {
    const binDir = join(tempDir, "empty-bin");
    await mkdir(binDir);
    process.env.PATH = binDir;

    const resolution = await resolveKitBinary({});
    expect(resolution).toMatchObject({ ok: true, binary: "visp", source: "fallback" });
    if (resolution.ok) {
      expect(resolution.found).toBe(false);
    }
  });

  it("reports found:false for a configured binary that does not exist", async () => {
    const binDir = join(tempDir, "cfg-bin");
    await mkdir(binDir);
    process.env.PATH = binDir;
    const projectPath = join(tempDir, "cfg-project");
    await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
    await writeFile(
      join(projectPath, ".visp", "hyper", "config.json"),
      JSON.stringify({ kitBinary: join(binDir, "does-not-exist") }),
      "utf8"
    );

    const resolution = await resolveKitBinary({ projectPath });
    expect(resolution).toMatchObject({ ok: true, source: "config" });
    if (resolution.ok) {
      expect(resolution.found).toBe(false);
    }
  });
});

describe("dual CLI identity negotiation (P10-US-03)", () => {
  const contract = (cliName: string) => ({
    contractVersion: "2.0",
    kit: { packageName: "visp-kit", cliName, version: "0.4.0" },
    protocols: {
      workflowAction: {
        supported: ["2.0", "3.0", "3.1", "3.2", "3.4"],
        default: "2.0",
        schemaHashes: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES
      }
    }
  });

  it("accepts both visp and visp-kit CLI identities", () => {
    for (const cliName of ["visp", "visp-kit"]) {
      const result = selectWorkflowActionProtocol(contract(cliName), "auto");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.protocolVersion).toBe("3.4");
      }
    }
  });

  it("still rejects any other CLI identity", () => {
    const result = selectWorkflowActionProtocol(contract("visp-hyper"), "auto");
    expect(result).toMatchObject({ ok: false, reasonCode: "unsupported_integration_contract" });
  });
});

describe("3.4 verification (P10-US-01/03)", () => {
  const selection: WorkflowActionProtocolSelection = {
    protocolVersion: "3.4",
    mode: "advertised",
    localSchemaHash: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.4"],
    schemaHashVerification: {
      state: "advertised_verified",
      advertisedHash: TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.4"]
    }
  } as WorkflowActionProtocolSelection;

  it("normalizes a valid 3.4 action", () => {
    const action = workflowActionV34Fixture();
    expect(workflowActionV34StrictSchema.parse(action)).toBeTruthy();
    const normalized = normalizeWorkflowAction(action, selection);
    expect(normalized.ok).toBe(true);
  });

  it("the 3.4 identity survives a rename of every command string", () => {
    const original = workflowActionV34Fixture();
    const renamed = workflowActionV34Fixture({ nextCommand: "visp-kit renamed --task T001" });
    expect(renamed.nextCommand).not.toBe(original.nextCommand);
    expect(renamed.actionId).toBe(original.actionId);
    // And the independent recomputation agrees.
    expect(createWorkflowActionV34Id(renamed)).toBe(original.actionId);
  });

  it("rejects a 3.4 action whose id does not match its projected body", () => {
    const action = workflowActionV34Fixture({ goal: "tampered after hashing" });
    const tampered = { ...action, goal: "a different goal entirely" };
    const normalized = normalizeWorkflowAction(tampered, selection);
    expect(normalized).toMatchObject({ ok: false, reasonCode: "workflow_action_identity_invalid" });
  });
});
