import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBatchExecArgs,
  execFileResolved,
  resolveExecutable
} from "../../../src/core/executable-resolver.js";
import { writeGlobalInstallShims, writePosixShim } from "../../helpers/fake-executable.js";
import { withPlatform } from "../../helpers/platform-override.js";

const WINDOWS = process.platform === "win32";
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("resolveExecutable", () => {
  it("resolves a real on-PATH executable (node)", async () => {
    const resolved = await resolveExecutable("node");
    expect(resolved).not.toBeNull();
    // On win32 this is node.exe (not a batch); elsewhere the bare name.
    expect(resolved!.batchPath).toBeUndefined();
  });

  it("returns null for a command that exists nowhere", async () => {
    // Isolate PATH so the bogus name cannot accidentally resolve.
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    const resolved = await resolveExecutable("definitely-not-a-real-cmd-xyz");
    if (WINDOWS) {
      expect(resolved).toBeNull();
    } else {
      // POSIX defers resolution to execFile, so a bare name is returned as-is.
      expect(resolved!.file).toBe("definitely-not-a-real-cmd-xyz");
    }
  });

  it.runIf(WINDOWS)("routes a .cmd shim through cmd.exe via batchPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-cmd-"));
    const shim = join(dir, "mytool.cmd");
    await writeFile(shim, "@echo off\r\necho hi\r\n", "utf8");
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;

    const resolved = await resolveExecutable("mytool");
    expect(resolved).not.toBeNull();
    expect(resolved!.batchPath).toBe(shim);
    expect(resolved!.file.toLowerCase()).toContain("cmd.exe");
  });
});

// LC-60: the question `resolveExecutable` cannot answer ("is it there?") and
// `findExecutableOnPath` cannot answer for an explicit path (joining a PATH
// directory to an absolute path yields nonsense). Windows resolution is asserted
// with the platform injected — see tests/helpers/platform-override.ts for why
// `it.runIf(WINDOWS)` is not an option for a decision this load-bearing.
describe("findRunnableCommand", () => {
  let binDir: string;
  const originalPathExt = process.env.PATHEXT;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), "visp-runnable-"));
    // The shape `npm install -g` leaves: an extensionless `#!/bin/sh` script
    // for Git Bash, and the `.cmd` wrapper Windows actually starts.
    await writeGlobalInstallShims(binDir, "visp-kit");
    process.env.PATH = binDir;
  });

  afterEach(() => {
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
  });

  it("picks the .cmd shim over the extensionless sibling on win32", async () => {
    await withPlatform("win32", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand("visp-kit")).toBe(join(binDir, "visp-kit.cmd"));
    });
  });

  it("PATHEXT-completes an explicit path with no extension on win32", async () => {
    await withPlatform("win32", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand(join(binDir, "visp-kit"))).toBe(
        join(binDir, "visp-kit.cmd")
      );
    });
  });

  it("returns null on win32 when only the unstartable extensionless file exists", async () => {
    const shOnly = await mkdtemp(join(tmpdir(), "visp-shonly-"));
    await writePosixShim(shOnly, "visp-kit");
    process.env.PATH = shOnly;

    await withPlatform("win32", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand("visp-kit")).toBeNull();
      expect(await findRunnableCommand(join(shOnly, "visp-kit"))).toBeNull();
    });
  });

  it("obeys the host PATHEXT rather than a list of its own", async () => {
    process.env.PATHEXT = ".COM;.EXE";
    await withPlatform("win32", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand("visp-kit")).toBeNull();
    });
  });

  it("takes the extensionless executable on POSIX, where that is the real one", async () => {
    await withPlatform("linux", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand("visp-kit")).toBe(join(binDir, "visp-kit"));
      expect(await findRunnableCommand(join(binDir, "visp-kit"))).toBe(join(binDir, "visp-kit"));
    });
  });

  it("returns null on POSIX for a file without the execute bit", async () => {
    const notExec = await mkdtemp(join(tmpdir(), "visp-noexec-"));
    await writeFile(join(notExec, "visp-kit"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    process.env.PATH = notExec;

    await withPlatform("linux", async () => {
      const { findRunnableCommand } = await import("../../../src/core/executable-resolver.js");
      expect(await findRunnableCommand("visp-kit")).toBeNull();
      expect(await findRunnableCommand(join(notExec, "visp-kit"))).toBeNull();
    });
  });
});

describe("buildBatchExecArgs", () => {
  it("quotes the batch path and every arg, wrapping the whole payload once", () => {
    const args = buildBatchExecArgs("C:\\Program Files\\tool\\x.cmd", ["a", "b c"]);
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Single wrapped verbatim payload with each token double-quoted.
    expect(args[3]).toBe('""C:\\Program Files\\tool\\x.cmd" "a" "b c""');
  });

  it("keeps shell metacharacters literal (no command chaining)", () => {
    const args = buildBatchExecArgs("x.cmd", ["a&whoami", "b|c"]);
    // The metacharacters stay inside their quoted tokens; they cannot chain.
    expect(args[3]).toBe('""x.cmd" "a&whoami" "b|c""');
  });

  it("escapes embedded double quotes per cmd.exe rules", () => {
    const args = buildBatchExecArgs("x.cmd", ['say "hi"']);
    expect(args[3]).toBe('""x.cmd" "say ""hi""""');
  });
});

describe("execFileResolved", () => {
  it("runs a resolved command and returns its stdout", async () => {
    const { stdout } = await execFileResolved("node", ["--version"]);
    expect(stdout.trim()).toMatch(/^v\d+/u);
  });

  it("throws ENOENT when nothing resolves", async () => {
    process.env.PATH = await mkdtemp(join(tmpdir(), "visp-empty-"));
    await expect(
      execFileResolved("definitely-not-a-real-cmd-xyz", ["--version"])
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(WINDOWS)("passes args to a .cmd shim as intact argv (no command chaining)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "visp-cmd-run-"));
    const shim = join(dir, "argecho.cmd");
    // Forward argv to node, which prints its raw argv as JSON. This proves the
    // program the shim launches receives one literal token, not a chained
    // command — the real property that matters for git/npm/pnpm/visp.
    await writeFile(shim, '@echo off\r\nnode -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n', "utf8");
    process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;

    const { stdout } = await execFileResolved("argecho", ["a&whoami", "b c"]);
    expect(JSON.parse(stdout)).toEqual(["a&whoami", "b c"]);
  });
});
