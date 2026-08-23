// The guard on the harness.
//
// tests/setup/path-twin-farm.ts builds the sanitised PATH every other test in
// this repository runs against. It is invisible machinery: when it substitutes
// the wrong twin, nothing fails — the run simply measures a different toolchain
// than the one it reports on, which is the exact failure mode this product
// claims to catch.
//
// So the farm is driven directly here, against a scratch farm root, with the
// stale and half-built twins a real machine accumulates constructed by hand.
//
// WHICH OF THESE ACTUALLY DISCRIMINATE. Four do: "gives two directories
// different twins", "ignores a twin an earlier run left behind", "rebuilds a
// twin a crashed run left half-built" and "rebuilds when the source directory
// has gained an entry" were each confirmed red against the version that keyed
// twins by PATH position and accepted any twin that merely existed (LC-35).
// The rest state the base behaviour that must survive the change — they pass
// against the old implementation too, and are here to stop the fix trading one
// silent wrongness for another, not as evidence for it.

import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sanitisePath } from "../../setup/path-twin-farm.js";

let farmRoot: string;
let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "visp-twin-farm-"));
  farmRoot = join(scratch, "farm");
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A PATH directory holding `entries`, each an ordinary file. */
async function binDirectory(name: string, entries: readonly string[]): Promise<string> {
  const directory = join(scratch, name);
  await mkdir(directory, { recursive: true });
  for (const entry of entries) {
    await writeFile(join(directory, entry), "#!/bin/sh\nexit 0\n", "utf8");
  }
  return directory;
}

/** Sanitise a PATH of exactly one directory and return what replaced it. */
function twinOf(directory: string): string {
  return sanitisePath({ path: directory, farmRoot });
}

/** What a resolver walking this directory would find in it. */
async function reachableIn(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => !entry.startsWith("."));
}

describe("the PATH twin farm", () => {
  it("removes the ambient Visp toolchain and keeps everything else", async () => {
    const directory = await binDirectory("bin-a", ["visp", "visp-kit", "visp-hyper", "ripgrep"]);

    const reachable = await reachableIn(twinOf(directory));

    expect(reachable).toContain("ripgrep");
    expect(
      reachable,
      "an ambient Kit survived the isolation, so every fixture project would be driven by " +
        "the real engine instead of the stub the test built"
    ).not.toContain("visp-kit");
    expect(reachable).not.toContain("visp");
    expect(reachable).not.toContain("visp-hyper");
  });

  it("leaves a directory that provides no Visp toolchain exactly where it was", async () => {
    // The isolation must be a scalpel: dropping whole directories would take
    // node, npm and visp-memory with them.
    const directory = await binDirectory("bin-plain", ["node", "visp-memory"]);

    expect(sanitisePath({ path: directory, farmRoot })).toBe(directory);
  });

  it("gives two directories different twins, whatever order PATH puts them in", async () => {
    // The defect: twins were named `dir-${index}` after the source directory's
    // POSITION in PATH. Both of these are the first entry of their own PATH, so
    // both used to be `dir-0` — and the second call returned the first
    // directory's twin without ever looking inside it.
    const first = await binDirectory("bin-first", ["visp-kit", "only-in-first"]);
    const second = await binDirectory("bin-second", ["visp-kit", "only-in-second"]);

    const firstTwin = twinOf(first);
    const secondTwin = twinOf(second);

    expect(secondTwin).not.toBe(firstTwin);
    expect(
      await reachableIn(secondTwin),
      "the twin of a different PATH directory was substituted for this one, so a tool this " +
        "run needs silently vanished from PATH"
    ).toContain("only-in-second");
    expect(await reachableIn(firstTwin)).toContain("only-in-first");
  });

  it("ignores a twin an earlier run left behind under a name it no longer uses", async () => {
    // The live failure, reconstructed: the farm is a stable path in tmpdir, so
    // it carries whatever previous runs left there. A `dir-0` from a run with a
    // different PATH ordering used to be reused unread — and this one still
    // provides the Kit the isolation exists to remove.
    await mkdir(join(farmRoot, "dir-0"), { recursive: true });
    await writeFile(join(farmRoot, "dir-0", "visp-kit"), "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(join(farmRoot, "dir-0", "only-in-stale-twin"), "", "utf8");

    const directory = await binDirectory("bin-c", ["visp-kit", "only-in-source"]);
    const reachable = await reachableIn(twinOf(directory));

    expect(
      reachable,
      "a twin left by an earlier run was reused unvalidated, and it still provides visp-kit"
    ).not.toContain("visp-kit");
    expect(reachable).not.toContain("only-in-stale-twin");
    expect(reachable).toContain("only-in-source");
  });

  it("rebuilds a twin a crashed run left half-built", async () => {
    // `mkdirSync` then a crash before the links were written leaves a directory
    // that is `existsSync`-true forever after. Everything the source directory
    // provided is then gone from PATH, silently, for every run on this machine
    // from then on.
    const directory = await binDirectory("bin-d", ["visp-kit", "only-in-source"]);
    const twin = twinOf(directory);
    for (const entry of await readdir(twin)) {
      await rm(join(twin, entry), { recursive: true, force: true });
    }

    const rebuilt = twinOf(directory);
    const reachable = await reachableIn(rebuilt);

    expect(
      reachable,
      "an empty directory left by an interrupted run was accepted as a finished twin"
    ).toContain("only-in-source");
    // Without this the case is satisfied by an implementation that gave up and
    // returned the source directory — which reaches `only-in-source` and the
    // ambient Kit alike.
    expect(rebuilt).not.toBe(directory);
    expect(reachable).not.toContain("visp-kit");
  });

  it("rebuilds when the source directory has gained an entry since the twin was built", async () => {
    // A twin keyed only on the source path would never notice this. The entry
    // listing is what the twin mirrors, so it is part of the twin's identity —
    // and unlike the directory's mtime it does not depend on the filesystem's
    // timestamp granularity, so this case decides the same way everywhere.
    const directory = await binDirectory("bin-e", ["visp-kit", "only-in-source"]);
    twinOf(directory);

    await writeFile(join(directory, "installed-later"), "", "utf8");
    const rebuilt = twinOf(directory);
    const reachable = await reachableIn(rebuilt);

    expect(
      reachable,
      "the twin was built before this entry existed and was reused anyway, so a tool the run " +
        "needs is missing from PATH"
    ).toContain("installed-later");
    expect(reachable).toContain("only-in-source");
    expect(rebuilt).not.toBe(directory);
    expect(reachable).not.toContain("visp-kit");
  });

  it("aborts the run rather than passing a directory through unsanitised", async () => {
    // The failure mode this whole file exists to prevent is a run that looks
    // normal while measuring the wrong toolchain. So a twin that cannot be
    // built is loud: `tests/setup/build-dist.ts` sets the same precedent for
    // `dist/`, because no test result is more trustworthy than the artifact it
    // ran against.
    const directory = await binDirectory("bin-f", ["visp-kit", "only-in-source"]);
    const blocked = join(scratch, "not-a-directory");
    await writeFile(blocked, "", "utf8");

    expect(() => sanitisePath({ path: directory, farmRoot: join(blocked, "farm") })).toThrow(
      /could not remove the installed Visp toolchain/u
    );
  });

  it("still shadows the toolchain after a symlinked entry is followed", async () => {
    // A real global bin directory is mostly symlinks (`npm install -g` writes
    // them), so the twin's own links point at links. The entry NAME is what
    // decides, and it has to keep deciding through a level of indirection.
    const target = await binDirectory("bin-target", ["visp-kit"]);
    const directory = join(scratch, "bin-linked");
    await mkdir(directory, { recursive: true });
    await symlink(join(target, "visp-kit"), join(directory, "visp-kit"));
    await symlink(join(target, "visp-kit"), join(directory, "harmless"));

    const reachable = await reachableIn(twinOf(directory));

    expect(reachable).not.toContain("visp-kit");
    expect(reachable).toContain("harmless");
  });

  it("passes a PATH entry that does not exist straight through", async () => {
    const missing = join(scratch, "never-created");

    expect(sanitisePath({ path: missing, farmRoot })).toBe(missing);
  });
});
