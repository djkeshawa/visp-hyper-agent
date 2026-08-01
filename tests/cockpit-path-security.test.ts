import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeCockpitRunId,
  isSafeCockpitRunId,
  resolveContainedExistingPath
} from "../src/cockpit/path-security.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.allSettled(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.add(path);
  return path;
}

describe("Cockpit safe path segments", () => {
  it.each(["run-0001", "RUN_2026.08.01", "a", "0-._value"])(
    "accepts the single safe segment %s",
    (value) => {
      expect(isSafeCockpitRunId(value)).toBe(true);
      expect(assertSafeCockpitRunId(value)).toBe(value);
    }
  );

  it.each([
    "",
    ".",
    "..",
    "../run",
    "run/child",
    "run\\child",
    "/absolute",
    "C:\\absolute",
    " run",
    "run ",
    "run?query",
    "run#fragment",
    "run%2Fchild",
    "%2e%2e",
    "%252e%252e",
    "%41",
    "run+child",
    "rún",
    "run\u0000child"
  ])("rejects unsafe or encoded-looking segment %j", (value) => {
    expect(isSafeCockpitRunId(value)).toBe(false);
    expect(() => assertSafeCockpitRunId(value)).toThrow(/safe path segment/u);
  });
});

describe("Cockpit resolved path containment", () => {
  it("returns canonical contained file and POSIX provenance", async () => {
    const projectPath = await temporaryDirectory("visp-cockpit-contained-");
    const filePath = join(projectPath, ".visp", "runs", "run-0001", "events.jsonl");
    await mkdir(join(projectPath, ".visp", "runs", "run-0001"), { recursive: true });
    await writeFile(filePath, "{}\n", "utf8");

    const result = await resolveContainedExistingPath(
      projectPath,
      ".visp/runs/run-0001/events.jsonl",
      "file"
    );
    expect(result.absolutePath).toBe(await realpath(filePath));
    expect(result.relativePath).toBe(".visp/runs/run-0001/events.jsonl");
    expect(result.relativePath).not.toContain("\\");
  });

  it("enforces the requested file or directory kind", async () => {
    const projectPath = await temporaryDirectory("visp-cockpit-kind-");
    const directoryPath = join(projectPath, ".visp", "runs");
    const filePath = join(directoryPath, "index.json");
    await mkdir(directoryPath, { recursive: true });
    await writeFile(filePath, "{}\n", "utf8");

    await expect(resolveContainedExistingPath(projectPath, ".visp/runs", "directory")).resolves.toMatchObject({
      relativePath: ".visp/runs"
    });
    await expect(resolveContainedExistingPath(projectPath, ".visp/runs/index.json", "file")).resolves.toMatchObject({
      relativePath: ".visp/runs/index.json"
    });
    await expect(resolveContainedExistingPath(projectPath, ".visp/runs", "file")).rejects.toThrow(/file/u);
    await expect(
      resolveContainedExistingPath(projectPath, ".visp/runs/index.json", "directory")
    ).rejects.toThrow(/directory/u);
  });

  it("rejects lexical traversal, absolute paths, and missing candidates", async () => {
    const parentPath = await temporaryDirectory("visp-cockpit-lexical-");
    const projectPath = join(parentPath, "project");
    await mkdir(projectPath);
    await writeFile(join(parentPath, "outside.json"), "{}\n", "utf8");

    await expect(
      resolveContainedExistingPath(projectPath, "../outside.json", "file")
    ).rejects.toThrow(/escapes|relative/u);
    await expect(
      resolveContainedExistingPath(projectPath, join(parentPath, "outside.json"), "file")
    ).rejects.toThrow(/repository-relative/u);
    await expect(
      resolveContainedExistingPath(projectPath, ".visp/runs/missing/events.jsonl", "file")
    ).rejects.toThrow();
  });

  it.each(["directory", "file"] as const)(
    "rejects an outside target reached through a %s symlink",
    async (symlinkCase) => {
      const projectPath = await temporaryDirectory("visp-cockpit-symlink-project-");
      const outsidePath = await temporaryDirectory("visp-cockpit-symlink-outside-");
      const runsPath = join(projectPath, ".visp", "runs");
      const outsideEvents = join(outsidePath, "events.jsonl");
      await mkdir(runsPath, { recursive: true });
      await writeFile(outsideEvents, "{}\n", "utf8");

      let candidate: string;
      if (symlinkCase === "directory") {
        await symlink(outsidePath, join(runsPath, "safe-run"), "dir");
        candidate = ".visp/runs/safe-run/events.jsonl";
      } else {
        const runPath = join(runsPath, "safe-run");
        await mkdir(runPath);
        await symlink(outsideEvents, join(runPath, "events.jsonl"), "file");
        candidate = ".visp/runs/safe-run/events.jsonl";
      }

      await expect(resolveContainedExistingPath(projectPath, candidate, "file")).rejects.toThrow(
        /escapes|project root|symbolic/u
      );
      expect(relative(projectPath, outsideEvents)).toMatch(/^\.\./u);
    }
  );

  it.each(["directory", "file"] as const)(
    "rejects an in-project target reached through a %s symlink",
    async (symlinkCase) => {
      const projectPath = await temporaryDirectory("visp-cockpit-inroot-symlink-");
      const runsPath = join(projectPath, ".visp", "runs");
      const targetPath = join(projectPath, ".visp", "physical-run");
      const targetEvents = join(targetPath, "events.jsonl");
      await mkdir(runsPath, { recursive: true });
      await mkdir(targetPath, { recursive: true });
      await writeFile(targetEvents, "{}\n", "utf8");

      const aliasPath = join(runsPath, "run-alias");
      let candidate: string;
      if (symlinkCase === "directory") {
        await symlink(targetPath, aliasPath, "dir");
        candidate = ".visp/runs/run-alias/events.jsonl";
      } else {
        await mkdir(aliasPath);
        await symlink(targetEvents, join(aliasPath, "events.jsonl"), "file");
        candidate = ".visp/runs/run-alias/events.jsonl";
      }

      await expect(resolveContainedExistingPath(projectPath, candidate, "file")).rejects.toThrow(
        /symbolic/u
      );
    }
  );
});
