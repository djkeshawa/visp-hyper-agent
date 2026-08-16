import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the suite's ONE build precondition.
 *
 * Four suites drive `dist/` rather than `src/`. Each was repaired individually
 * when it was caught failing on a clean clone, and each repair left the class
 * open for the next author: `tests/pack-smoke.test.ts` first, then
 * `tests/doctor-command.test.ts`, while `tests/degradation-regressions.test.ts`,
 * `tests/hooks-command.test.ts` and `tests/mcp-server.test.ts` still failed on a
 * first run. The precondition now belongs to the run — Vitest `globalSetup` —
 * so a new test simply inherits it.
 *
 * These assertions exist so that removing that mechanism, or reintroducing the
 * per-test one, fails a test instead of quietly restoring the ordering luck.
 */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const testsRoot = join(packageRoot, "tests");
const GLOBAL_SETUP = "tests/setup/build-dist.ts";
/** Derived, not spelled, so renaming this file cannot silently exempt nothing. */
const SELF = fileURLToPath(import.meta.url).slice(packageRoot.length + 1).replaceAll("\\", "/");

/**
 * Matches a package-manager build passed as an argv array — an actual spawn,
 * not a prose mention of one. Comments and error strings that talk about the
 * build (there are several, deliberately) must not trip this.
 *
 * Two files are exempt: the globalSetup, which is where the build belongs, and
 * this file, which cannot help containing the shape it hunts for.
 */
const SPAWNS_A_BUILD = /["'`](?:pnpm|npm|yarn)["'`]\s*,\s*\[\s*["'`]build["'`]/u;
const EXEMPT = new Set([GLOBAL_SETUP, SELF]);

async function testSourceFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await testSourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

describe("the suite's build precondition", () => {
  it("has produced dist/index.js before any test runs", async () => {
    // Not `existsSync` as a courtesy: this is the assertion. If globalSetup is
    // gone, every dist-driven suite is back to passing by ordering luck, and
    // this says so in one line instead of five confusing spawn failures.
    const built = await readFile(join(packageRoot, "dist", "index.js"), "utf8");
    expect(built.length).toBeGreaterThan(0);
  });

  it("has produced a dist/ that matches today's source, not an older build", async () => {
    // The per-test repairs guarded existence with `includes('"serve"')` /
    // `includes('"guard"')` precisely because a stale dist is as wrong as a
    // missing one — it reports on code that is not the code under test. The
    // globalSetup build is unconditional, so every command the spawning suites
    // drive is necessarily present.
    const built = await readFile(join(packageRoot, "dist", "index.js"), "utf8");
    for (const command of ["serve", "guard", "remember", "cockpit"]) {
      expect(built, `dist/index.js is missing the '${command}' command`).toContain(`"${command}"`);
    }
  });

  it("declares that build as Vitest globalSetup, so no test has to ask for it", async () => {
    const config = await readFile(join(packageRoot, "vitest.config.ts"), "utf8");
    expect(config).toMatch(/globalSetup:\s*\[\s*"tests\/setup\/build-dist\.ts"\s*\]/u);
  });

  it("keeps the build in exactly one place — no test spawns its own", async () => {
    const offenders: string[] = [];
    for (const file of await testSourceFiles(testsRoot)) {
      const relative = file.slice(packageRoot.length + 1).replaceAll("\\", "/");
      if (EXEMPT.has(relative)) continue;
      if (SPAWNS_A_BUILD.test(await readFile(file, "utf8"))) offenders.push(relative);
    }

    expect(
      offenders,
      `These test files build the package themselves. That is the per-test repair ` +
        `this suite has already made three times: it fixes the file it is written in, ` +
        `races other workers (tsup runs with clean: true), and leaves the next author ` +
        `to rediscover the rule. The build belongs in ${GLOBAL_SETUP}.`
    ).toEqual([]);
  });
});
