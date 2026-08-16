// Whether the context a handoff was built from still describes the working tree.
//
// The whole point of this check is that a STALE answer must be indistinguishable
// from no answer: every degraded shape has to come back `blocking`, because a
// non-blocking "probably fine" is how an agent gets handed a context pack that
// no longer matches the files it is about to edit.
//
// `untracked` is the one non-blocking status, and it is reserved for "nothing
// claimed freshness here" — never for "something claimed it and could not be
// read". That distinction is what these tests hold.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkContextFreshness } from "../../../src/context/context-freshness.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function project(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "visp-freshness-"));
}

async function writeManifest(projectPath: string, manifest: unknown): Promise<void> {
  const dir = join(projectPath, ".visp", "hyper", "current");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "context-manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    "utf8"
  );
}

async function writeArtifact(
  projectPath: string,
  relativePath: string,
  contents: string
): Promise<void> {
  const absolute = join(projectPath, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents, "utf8");
}

function target(path: string, contents: string, label?: string): Record<string, unknown> {
  return { path, hash: sha256(contents), hashAlgorithm: "sha256", ...(label ? { label } : {}) };
}

describe("context freshness", () => {
  it("is untracked and non-blocking when no manifest was ever written", async () => {
    const result = await checkContextFreshness(await project());
    expect(result).toMatchObject({ status: "untracked", blocking: false });
    expect(result.warnings).toHaveLength(1);
  });

  it("blocks on a manifest that is not JSON", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, "{ truncated");

    const result = await checkContextFreshness(projectPath);
    expect(result.status).toBe("error");
    expect(result.blocking).toBe(true);
    expect(result.finding).toContain("unreadable");
  });

  it("blocks on a contextArtifact that is not an object", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, { contextArtifact: "docs/pack.md" });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "error", blocking: true });
    expect(result.finding).toContain("invalid artifact freshness metadata");
  });

  it("blocks on a contextArtifact missing a path, a hash or the sha256 algorithm", async () => {
    for (const artifact of [
      { hash: sha256("x"), hashAlgorithm: "sha256" },
      { path: "pack.md", hashAlgorithm: "sha256" },
      { path: "pack.md", hash: sha256("x") },
      { path: "pack.md", hash: sha256("x"), hashAlgorithm: "md5" }
    ]) {
      const projectPath = await project();
      await writeManifest(projectPath, { contextArtifact: artifact });

      const result = await checkContextFreshness(projectPath);
      expect(result, JSON.stringify(artifact)).toMatchObject({ status: "error", blocking: true });
    }
  });

  it("blocks when artifactProvenance is present but is not a list", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, { artifactProvenance: { "pack.md": sha256("x") } });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "error", blocking: true });
    expect(result.finding).toContain("invalid artifact provenance metadata");
  });

  it("blocks on a provenance entry that is not a valid target", async () => {
    const projectPath = await project();
    await writeArtifact(projectPath, "pack.md", "one");
    await writeManifest(projectPath, {
      artifactProvenance: [target("pack.md", "one"), { path: "other.md" }]
    });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "error", blocking: true });
    expect(result.finding).toContain("invalid artifact provenance metadata");
  });

  it("is untracked when a manifest exists but claims freshness for nothing", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, { artifactProvenance: [] });

    expect(await checkContextFreshness(projectPath)).toMatchObject({
      status: "untracked",
      blocking: false
    });
  });

  it("blocks on a target path that escapes the project", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, { contextArtifact: target("../outside.md", "one") });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "error", blocking: true, artifactPath: "../outside.md" });
    expect(result.finding).toContain("escapes the project");
  });

  it("reports a deleted artifact as missing, with the hash it expected", async () => {
    const projectPath = await project();
    await writeManifest(projectPath, { contextArtifact: target("pack.md", "one", "context pack") });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({
      status: "missing",
      blocking: true,
      artifactPath: "pack.md",
      expectedHash: sha256("one")
    });
    // The label is what tells a reader WHICH artifact vanished.
    expect(result.finding).toContain("context pack at pack.md");
  });

  it("reports an unreadable artifact as an error, not as missing", async () => {
    // A directory where a file was expected is not a deletion. Folding it into
    // `missing` would send the user to regenerate a pack that is already there.
    const projectPath = await project();
    await mkdir(join(projectPath, "pack.md"), { recursive: true });
    await writeManifest(projectPath, { contextArtifact: target("pack.md", "one") });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "error", blocking: true, artifactPath: "pack.md" });
    expect(result.finding).toContain("could not be read");
    expect(result.warnings).toHaveLength(1);
  });

  it("reports a changed artifact as stale, with both hashes", async () => {
    const projectPath = await project();
    await writeArtifact(projectPath, "pack.md", "two");
    await writeManifest(projectPath, { contextArtifact: target("pack.md", "one") });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({
      status: "stale",
      blocking: true,
      expectedHash: sha256("one"),
      actualHash: sha256("two")
    });
  });

  it("is current and non-blocking when every tracked artifact still hashes the same", async () => {
    const projectPath = await project();
    await writeArtifact(projectPath, "pack.md", "one");
    await writeArtifact(projectPath, "docs/notes.md", "two");
    await writeManifest(projectPath, {
      contextArtifact: target("pack.md", "one"),
      artifactProvenance: [target("docs/notes.md", "two")]
    });

    expect(await checkContextFreshness(projectPath)).toMatchObject({
      status: "current",
      blocking: false,
      artifactPath: "docs/notes.md"
    });
  });

  it("blocks on the first stale artifact even when a later one is current", async () => {
    const projectPath = await project();
    await writeArtifact(projectPath, "pack.md", "changed");
    await writeArtifact(projectPath, "docs/notes.md", "two");
    await writeManifest(projectPath, {
      contextArtifact: target("pack.md", "one"),
      artifactProvenance: [target("docs/notes.md", "two")]
    });

    expect(await checkContextFreshness(projectPath)).toMatchObject({
      status: "stale",
      blocking: true,
      artifactPath: "pack.md"
    });
  });

  it("carries the manifest's own freshness warnings ahead of the check's", async () => {
    const projectPath = await project();
    await mkdir(join(projectPath, "pack.md"), { recursive: true });
    await writeManifest(projectPath, {
      contextArtifact: target("pack.md", "one"),
      freshnessWarnings: ["scout skipped two files", "  ", 42, ""]
    });

    const result = await checkContextFreshness(projectPath);
    // Blank and non-string entries are dropped; the manifest's warning comes
    // first because it describes how the context was built, which explains the
    // read failure that follows.
    expect(result.warnings[0]).toBe("scout skipped two files");
    expect(result.warnings).toHaveLength(2);
  });

  it("ignores freshnessWarnings that are not a list rather than failing the check", async () => {
    const projectPath = await project();
    await writeArtifact(projectPath, "pack.md", "one");
    await writeManifest(projectPath, {
      contextArtifact: target("pack.md", "one"),
      freshnessWarnings: "scout skipped two files"
    });

    const result = await checkContextFreshness(projectPath);
    expect(result).toMatchObject({ status: "current", blocking: false });
    expect(result.warnings).toEqual([]);
  });
});
