// P10-US-03: the bridge release. Binary resolution (env → config →
// visp-kit probe → visp fallback), the self-invocation guard, dual CLI
// identity in negotiation, and 3.4 verification with the wording-invariance
// guarantee the projection exists to provide.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSelfInvocation, resolveKitBinary } from "../../../src/kit/kit-binary-resolver.js";
import {
  writeCmdShim,
  writeGlobalInstallShims,
  writeNodeExecutable,
  writePackageResidentExecutable,
  writePosixShim
} from "../../helpers/fake-executable.js";
import { withPlatform } from "../../helpers/platform-override.js";
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
const originalPathExt = process.env.PATHEXT;

/**
 * Put `name` on PATH in `binDir` in whatever shape the HOST platform can
 * actually start, and return the path a caller should name.
 *
 * These tests used to hand-roll an extensionless `#!/bin/sh` file plus `chmod`.
 * That is not an executable on Windows in any sense — no shebang, `chmod` a
 * no-op, and the name is not on PATHEXT — so the fake was silently absent
 * there. LC-56 replaced that shape everywhere else with the single helper; this
 * file and path-isolation.test.ts were the last two holdouts (LC-60).
 */
async function putOnPath(binDir: string, name: string): Promise<string> {
  return await writeNodeExecutable(binDir, name, "process.exit(0);");
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
    await putOnPath(binDir, "visp-kit");
    await putOnPath(binDir, "visp");
    process.env.PATH = binDir;

    const resolution = await resolveKitBinary({});
    expect(resolution).toEqual({ ok: true, binary: "visp-kit", source: "probe", found: true });
  });

  it("falls back to visp when visp-kit is absent", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    await putOnPath(binDir, "visp");
    process.env.PATH = binDir;

    const resolution = await resolveKitBinary({});
    expect(resolution).toEqual({ ok: true, binary: "visp", source: "fallback", found: true });
  });

  it("VISP_KIT_BINARY overrides everything", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    const kit = await putOnPath(binDir, "visp-kit");
    process.env.PATH = binDir;
    process.env.VISP_KIT_BINARY = kit;

    const resolution = await resolveKitBinary({});
    expect(resolution).toMatchObject({ ok: true, source: "env", found: true });
  });

  it("reads kitBinary from .visp/hyper/config.json", async () => {
    const binDir = join(tempDir, "bin");
    await mkdir(binDir);
    const custom = await putOnPath(binDir, "my-kit");
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
  //
  // The fixture used to symlink an EXTENSIONLESS `visp` into a bin directory.
  // Windows resolves no such entry, so once this resolver started honouring
  // PATHEXT the fixture stopped putting a findable binary there at all and the
  // assertion went red — the fixture was wrong, not the guard. It now goes
  // through the helper, which arranges the same property in the shape each
  // platform can actually resolve. The assertion below is unchanged and now
  // holds on win32 too, where it previously could not pass.
  it("refuses a visp fallback that resolves into visp-hyper-agent itself", async () => {
    const packageDir = join(tempDir, "node_modules", "visp-hyper-agent", "dist");
    const { pathDir } = await writePackageResidentExecutable(packageDir, join(tempDir, "bin"), "visp");
    process.env.PATH = pathDir;

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

// LC-60. `npm install -g visp-kit` drops BOTH an extensionless `visp-kit` (a
// `#!/bin/sh` script, there for Git Bash) and a `visp-kit.cmd` into the same
// directory. On Windows only the second is startable: `CreateProcess` and
// `cmd.exe` resolve by PATHEXT, and `fs.access(X_OK)` — which the resolver used
// to ask — is not even a question Windows answers, it reports every existing
// file as executable.
//
// The resolver therefore used to return `found: true` naming a file the host
// cannot run, and `found` is documented as meaning LOCATED rather than guessed.
// These assertions are about the resolution DECISION, so they run everywhere
// with the platform injected rather than being skipped off Windows.
describe("resolveKitBinary on win32", () => {
  let tempDir: string;
  const importResolver = async () => await import("../../../src/kit/kit-binary-resolver.js");

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "visp-binres-win-"));
    delete process.env.VISP_KIT_BINARY;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    if (originalKitBinary === undefined) {
      delete process.env.VISP_KIT_BINARY;
    } else {
      process.env.VISP_KIT_BINARY = originalKitBinary;
    }
  });

  // The self-invocation guard inspects whatever the resolver decided the host
  // would start, so it is the observable that names the chosen file: only the
  // `.cmd` leads into visp-hyper-agent here, the POSIX shim beside it is an
  // ordinary file. Picking the extensionless one defeats the guard.
  // Composition: the guard consults whatever findRunnableCommand decided, so a
  // Kit-shaped `.cmd` inside a visp-hyper-agent package is refused on win32.
  //
  // WHICH file the resolver picks when both siblings exist is asserted
  // directly, and symlink-free, in tests/unit/core/executable-resolver.test.ts
  // (findRunnableCommand returns the exact `.cmd` path). It is not re-asserted
  // here, because making two siblings in ONE directory resolve to different
  // packages requires a symlink, and a win32 symlink needs a privilege the
  // runner may not have — see tests/helpers/tool-path.ts. Rather than let that
  // degrade silently on Windows, the discrimination lives where it needs no
  // link, and this case pins the composition on every platform.
  it("refuses a package-resident .cmd through the self-invocation guard", async () => {
    const hyperDist = join(tempDir, "node_modules", "visp-hyper-agent", "dist");
    await writeCmdShim(hyperDist, "visp");
    process.env.PATH = hyperDist;

    await withPlatform("win32", async () => {
      const { isSelfInvocation: guard, resolveKitBinary: resolve } = await importResolver();
      expect(await guard("visp")).toBe(true);
      expect(await resolve({})).toMatchObject({ ok: false, reasonCode: "self_invocation" });
    });
  });

  it("reports found:false when only the extensionless sh script is installed", async () => {
    const binDir = join(tempDir, "sh-only");
    await writePosixShim(binDir, "visp-kit");
    process.env.PATH = binDir;

    await withPlatform("win32", async () => {
      const { resolveKitBinary: resolve } = await importResolver();
      const resolution = await resolve({});
      // Nothing PATHEXT-resolvable exists, so there is no located Kit at all —
      // the resolver falls through to the `visp` guess and says so.
      expect(resolution).toEqual({ ok: true, binary: "visp", source: "fallback", found: false });
    });
  });

  it("reports found:true once the .cmd shim is there too", async () => {
    const binDir = join(tempDir, "both");
    await writeGlobalInstallShims(binDir, "visp-kit");
    process.env.PATH = binDir;

    await withPlatform("win32", async () => {
      const { resolveKitBinary: resolve } = await importResolver();
      expect(await resolve({})).toEqual({
        ok: true,
        binary: "visp-kit",
        source: "probe",
        found: true
      });
    });
  });

  it("PATHEXT-completes a configured absolute path with no extension", async () => {
    const binDir = join(tempDir, "cfg");
    const { posixShim } = await writeGlobalInstallShims(binDir, "my-kit");
    process.env.PATH = binDir;

    await withPlatform("win32", async () => {
      const { resolveKitBinary: resolve } = await importResolver();
      // The user names `<dir>/my-kit`; Windows starts `<dir>/my-kit.cmd`.
      expect(await resolve({ configured: posixShim })).toMatchObject({
        ok: true,
        source: "config",
        found: true
      });
    });
  });

  it("honours a PATHEXT that does not list .cmd", async () => {
    const binDir = join(tempDir, "pathext");
    await writeGlobalInstallShims(binDir, "visp-kit");
    process.env.PATH = binDir;
    process.env.PATHEXT = ".COM;.EXE";

    await withPlatform("win32", async () => {
      const { resolveKitBinary: resolve } = await importResolver();
      // PATHEXT is the host's own list, not a constant this repository invents.
      // With .CMD off it, the shim is not startable and must not count as found.
      expect(await resolve({})).toMatchObject({ source: "fallback", found: false });
    });
  });

  it("still finds the extensionless executable on POSIX", async () => {
    const binDir = join(tempDir, "posix");
    await writeGlobalInstallShims(binDir, "visp-kit");
    process.env.PATH = binDir;

    await withPlatform("linux", async () => {
      const { resolveKitBinary: resolve } = await importResolver();
      expect(await resolve({})).toEqual({
        ok: true,
        binary: "visp-kit",
        source: "probe",
        found: true
      });
    });
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
