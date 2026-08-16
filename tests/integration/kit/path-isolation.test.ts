// The guard on the guard.
//
// tests/setup/isolate-installed-visp.ts strips a globally installed Kit from
// PATH so the suite tests this repository rather than whatever the developer
// happens to have installed. That setup is invisible: if it silently stopped
// working, every other test would keep passing on a clean machine and 187 of
// them would fail on a machine with the product installed — which is the state
// this repository was actually in.
//
// So the isolation gets its own assertions, and they are written to fail
// whether the setup file is removed, misconfigured, or quietly outgrown.

import { execFile } from "node:child_process";
import { delimiter } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { resolveKitBinary } from "../../../src/kit/kit-binary-resolver.js";

const execFileAsync = promisify(execFile);

async function onPath(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe("the suite does not see an installed Visp toolchain", () => {
  it("finds no ambient visp-kit", async () => {
    expect(
      await onPath("visp-kit"),
      "A globally installed visp-kit is reachable from the tests. Every fixture project " +
        "would then be driven by the real engine instead of the stub the test built, and " +
        "187 tests fail. See tests/setup/isolate-installed-visp.ts."
    ).toBe(false);
  });

  it("finds no ambient visp or visp-hyper", async () => {
    expect(await onPath("visp")).toBe(false);
    expect(await onPath("visp-hyper")).toBe(false);
  });

  it("resolves Kit as not-found rather than to an installed binary", async () => {
    // The resolver is what actually decides, so assert on it and not only on
    // the shell. `found: false` is the state the fixtures are written against.
    const resolution = await resolveKitBinary({});

    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(
        resolution.found,
        `resolveKitBinary located "${resolution.binary}" via ${resolution.source}. ` +
          "The isolation is not covering that path."
      ).toBe(false);
    }
  });

  it("leaves the rest of PATH intact", async () => {
    // The isolation must be a scalpel. Dropping whole directories would take
    // node, npm and visp-memory with them — and the memory contract test
    // deliberately requires the real visp-memory rather than skipping.
    expect(await onPath("node"), "node fell off PATH; the isolation is too broad").toBe(true);
    expect((process.env.PATH ?? "").split(delimiter).length).toBeGreaterThan(1);
  });

  it("still lets a test supply its own Kit", async () => {
    // The whole point is to remove the AMBIENT one, not to make stubbing
    // impossible — sixteen test files stub Kit by prepending a shim.
    const { chmod, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const binDir = await mkdtemp(join(tmpdir(), "visp-isolation-stub-"));
    const shim = join(binDir, "visp-kit");
    await writeFile(shim, "#!/bin/sh\necho stub\n", "utf8");
    await chmod(shim, 0o755);

    const original = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${original}`;
    try {
      const resolution = await resolveKitBinary({});
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        expect(resolution.found, "a test-supplied Kit shim was not found").toBe(true);
      }
    } finally {
      process.env.PATH = original;
    }
  });
});
