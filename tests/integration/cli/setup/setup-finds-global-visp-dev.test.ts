// LC-9 — `visp setup` finds the visp-dev a user actually installed.
//
// On a clean machine the onboarding path closed on itself. `visp doctor`
// reported FAIL and said "Run `visp setup`"; `visp setup` said the Visp Dev
// machine-scope adapter "is not installed" and told the user to run
// `npm install -g visp-dev` — which they had already run, and which had
// worked: `visp-dev` was on PATH the whole time.
//
// The cause was one bare specifier. Node resolves `visp-dev/machine-scope`
// against Hyper's own node_modules chain, and a global install is not on it, so
// the import threw and the throw was read as "not installed". Nothing about
// that was visible from either message.
//
// So the behaviour under test is the user's situation, not the resolver's: a
// package installed globally, its command on PATH, and setup expected to run
// its machine scope instead of denying it exists. The fixture is built in the
// layout `npm install -g` writes on the platform the suite is running on, and
// PATH is replaced outright so the machine's own visp-dev cannot answer for it.

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSetupVerb } from "../../../../src/cli/machine/machine-scope.js";

const WINDOWS = process.platform === "win32";
/** The name `loadAdapter` looks for; a fixture under any other name proves nothing. */
const PACKAGE_NAME = "visp-dev";

let projectDir: string;
let prefix: string;
let originalPath: string | undefined;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "visp-setup-global-"));
  prefix = await mkdtemp(join(tmpdir(), "visp-global-prefix-"));
  originalPath = process.env.PATH;
});

afterEach(async () => {
  process.env.PATH = originalPath;
  process.exitCode = 0;
  vi.restoreAllMocks();
  await rm(projectDir, { recursive: true, force: true });
  await rm(prefix, { recursive: true, force: true });
});

/**
 * Write a package that exports a `machine-scope` adapter, and install it the
 * way `npm install -g` would. The adapter records the call so the test can tell
 * "setup ran the machine scope" from "setup printed something agreeable".
 */
async function installVispDevGlobally(): Promise<{ readonly binDir: string; readonly witness: string }> {
  const root = WINDOWS
    ? join(prefix, "node_modules", PACKAGE_NAME)
    : join(prefix, "lib", "node_modules", PACKAGE_NAME);
  const witness = join(prefix, "ran-machine-scope.json");

  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, "src", "machine-scope.mjs"),
    [
      'import { writeFile } from "node:fs/promises";',
      "export async function runSetup(input) {",
      `  await writeFile(${JSON.stringify(witness)}, JSON.stringify(input), "utf8");`,
      '  return { success: true, report: "visp-kit: ok.\\nSetup complete." };',
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        name: PACKAGE_NAME,
        version: "0.0.0-fixture",
        type: "module",
        exports: { "./machine-scope": "./src/machine-scope.mjs" }
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  if (WINDOWS) {
    await writeFile(join(prefix, `${PACKAGE_NAME}.cmd`), "@echo off\r\n", "utf8");
    return { binDir: prefix, witness };
  }

  const entry = join(root, "scripts", "cli.mjs");
  await writeFile(entry, "#!/usr/bin/env node\n", "utf8");
  await chmod(entry, 0o755);
  const binDir = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  await symlink(entry, join(binDir, PACKAGE_NAME));
  return { binDir, witness };
}

/** Run setup with PATH replaced, and return everything it printed. */
async function setupWithPath(pathDir: string): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void lines.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
  process.env.PATH = pathDir;

  await runSetupVerb(projectDir, []);
  return lines.join("\n");
}

describe("visp setup on a machine where visp-dev was installed globally", () => {
  it("runs the machine scope instead of reporting the adapter missing", async () => {
    const { binDir, witness } = await installVispDevGlobally();

    const output = await setupWithPath(binDir);

    expect(
      output,
      "setup denied an adapter that was installed and on PATH. That is the closed loop LC-9 " +
        "reports: doctor sends the user to setup, setup sends them to an install they have done."
    ).not.toContain("not installed");
    // Parse the witness rather than substring-matching its bytes: the adapter
    // records `JSON.stringify(input)`, and JSON escapes every backslash — so
    // on Windows the recorded `C:\Users\...` is spelled `C:\\Users\\...` on
    // disk and a raw `toContain` reports the right path as absent.
    const recorded = JSON.parse(await readFile(witness, "utf8")) as { projectPath?: string };
    expect(recorded.projectPath).toBe(projectDir);
  });

  it("does not fail the command when the adapter came from PATH", async () => {
    const { binDir } = await installVispDevGlobally();

    await setupWithPath(binDir);

    expect(process.exitCode).not.toBe(1);
  });

  it("still goes on to set the project up, so setup means what it says", async () => {
    const { binDir } = await installVispDevGlobally();

    await setupWithPath(binDir);

    await expect(
      readFile(join(projectDir, ".visp", "hyper", "config.json"), "utf8")
    ).resolves.toContain("memoryMode");
  });
});

describe("visp setup when nothing on the machine provides the adapter", () => {
  it("names the project-scope route rather than leaving the user nowhere to go", async () => {
    const empty = await mkdtemp(join(tmpdir(), "visp-empty-path-"));

    const output = await setupWithPath(empty);

    expect(
      output,
      "refusing is correct; refusing without naming a route that works is the dead end. " +
        "`visp-kit init .` needs no machine scope and was reachable the whole time."
    ).toContain("visp-kit init .");
    expect(process.exitCode).toBe(1);
  });
});
