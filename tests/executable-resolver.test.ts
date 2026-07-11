import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildBatchExecArgs,
  execFileResolved,
  resolveExecutable
} from "../src/core/executable-resolver.js";

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
