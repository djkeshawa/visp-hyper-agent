// P13-US-04 — the process boundary between Hyper and Kit.
//
// Written behaviour-first: the assertion below states what `visp new` MUST do
// with a multi-word goal, and it was written before the fix. It failed. That
// failure is the bug report.
//
// No per-repo unit test could catch this. Hyper's tests asserted the string it
// built; Kit's tests asserted the argv it received. The corruption happens
// BETWEEN them, at the whitespace split — so only a test that watches what
// actually crosses the process boundary can see it.

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KitCommandBridge } from "../../../src/kit/kit-command-bridge.js";
import { putNodeExecutableOnPath } from "../../helpers/fake-executable.js";

const originalPath = process.env.PATH;
let tempDir: string;

/** A stand-in engine that records exactly the argv it was handed. */
async function argvRecordingKit(dir: string): Promise<string> {
  const logPath = join(dir, "argv.json");
  await putNodeExecutableOnPath(
    join(dir, "bin"),
    "visp-kit",
    [
      'const { writeFileSync } = require("node:fs");',
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write(JSON.stringify({ success: true }));"
    ].join("\n")
  );
  return logPath;
}

describe("SEAM: a goal crosses the Hyper→Kit process boundary intact", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "visp-goal-seam-"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("passes a multi-word goal to Kit as ONE argument", async () => {
    const logPath = await argvRecordingKit(tempDir);
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const goal = "add a login page";
    await bridge.runMechanicalCommand(`visp-kit feature ${JSON.stringify(goal)}`);

    const argv = JSON.parse(await readFile(logPath, "utf8")) as string[];

    // What Kit must receive. Anything else means the goal was shredded on the
    // way across, and Kit registers a feature nobody asked for.
    expect(argv).toEqual(["feature", goal, "--json"]);
  });

  it("preserves a goal containing quotes and punctuation", async () => {
    const logPath = await argvRecordingKit(tempDir);
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const goal = 'support "smart quotes", commas and spaces';
    await bridge.runMechanicalCommand(`visp-kit feature ${JSON.stringify(goal)}`);

    const argv = JSON.parse(await readFile(logPath, "utf8")) as string[];
    expect(argv).toEqual(["feature", goal, "--json"]);
  });

  it("still refuses a command outside the mechanical allowlist", async () => {
    // The safety boundary must survive the fix: widening argv handling must not
    // widen WHAT may be run unattended.
    await argvRecordingKit(tempDir);
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const refused = await bridge.runMechanicalCommand('visp-kit publish "something"');
    expect(refused).toBeNull();
    expect(bridge.warnings.at(-1)).toMatch(/non-mechanical/u);
  });

  it("still refuses shell metacharacters", async () => {
    await argvRecordingKit(tempDir);
    const bridge = new KitCommandBridge({ projectPath: tempDir });

    const refused = await bridge.runMechanicalCommand("visp-kit feature goal; rm -rf /");
    expect(refused).toBeNull();
    expect(bridge.warnings.at(-1)).toMatch(/metacharacters|non-mechanical/u);
  });
});
