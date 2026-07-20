import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectFile } from "../src/core/project-path.js";

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "visp-project-path-"));
}

describe("resolveProjectFile", () => {
  it("resolves regular reads and missing write targets beneath the project", async () => {
    const project = await makeProject();
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "safe.ts"), "safe", "utf8");

    const read = await resolveProjectFile(project, "./src/safe.ts", { mode: "read" });
    expect(read.logicalPath).toBe("src/safe.ts");
    expect(read.resolvedRelativePath).toBe("src/safe.ts");
    expect(read.exists).toBe(true);

    const write = await resolveProjectFile(project, "generated/deep/file.txt", { mode: "write" });
    expect(write.resolvedRelativePath).toBe("generated/deep/file.txt");
    expect(write.exists).toBe(false);
  });

  it.each([
    "../secret.txt",
    "src/../secret.txt",
    "/tmp/secret.txt",
    "C:\\secret.txt",
    "C:secret.txt",
    "\\\\server\\share\\secret.txt",
    "bad\0path"
  ])("rejects unsafe lexical path %j", async (candidate) => {
    const project = await makeProject();
    await expect(resolveProjectFile(project, candidate, { mode: "write" })).rejects.toThrow(
      /Unsafe project path/
    );
  });

  it("rejects missing reads, directories, and dangling symlinks", async () => {
    const project = await makeProject();
    await mkdir(join(project, "directory"));
    await symlink(join(project, "missing-target"), join(project, "dangling"));

    await expect(resolveProjectFile(project, "missing.txt", { mode: "read" })).rejects.toThrow(
      /does not exist/
    );
    await expect(resolveProjectFile(project, "directory", { mode: "write" })).rejects.toThrow(
      /not a regular file/
    );
    await expect(resolveProjectFile(project, "dangling", { mode: "write" })).rejects.toThrow(
      /dangling or unreadable symlink/
    );
  });

  it("allows in-project symlinks and returns the canonical target for writes", async () => {
    const project = await makeProject();
    const targetDir = join(project, "internal", "assets");
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, "existing.txt"), "before", "utf8");
    await symlink(targetDir, join(project, "alias"), "dir");

    const read = await resolveProjectFile(project, "alias/existing.txt", { mode: "read" });
    expect(await readFile(read.absolutePath, "utf8")).toBe("before");
    expect(read.resolvedRelativePath).toBe("internal/assets/existing.txt");

    const write = await resolveProjectFile(project, "alias/new/deep.txt", { mode: "write" });
    expect(write.absolutePath).toBe(join(targetDir, "new", "deep.txt"));
    expect(write.exists).toBe(false);
  });

  it("rejects symlinks escaping the project for reads and writes", async () => {
    const project = await makeProject();
    const outside = await mkdtemp(join(tmpdir(), "visp-project-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(project, "escape"), "dir");

    await expect(resolveProjectFile(project, "escape/secret.txt", { mode: "read" })).rejects.toThrow(
      /resolved path escapes/
    );
    await expect(resolveProjectFile(project, "escape/new.txt", { mode: "write" })).rejects.toThrow(
      /resolved path escapes/
    );
  });

  it("rejects an intermediate symlink that escapes and later points back inside", async () => {
    const project = await makeProject();
    const inside = join(project, "inside");
    const outside = await mkdtemp(join(tmpdir(), "visp-project-bridge-"));
    await mkdir(inside);
    await writeFile(join(inside, "safe.txt"), "safe", "utf8");
    await symlink(inside, join(outside, "back"), "dir");
    await symlink(outside, join(project, "bridge"), "dir");

    await expect(resolveProjectFile(project, "bridge/back/safe.txt", { mode: "read" })).rejects.toThrow(
      /resolved path escapes/
    );
  });

  it("applies blocked rules to logical and resolved paths", async () => {
    const project = await makeProject();
    await writeFile(join(project, ".env"), "secret", "utf8");
    await mkdir(join(project, ".git", "assets"), { recursive: true });
    await writeFile(join(project, ".git", "assets", "hidden.txt"), "hidden", "utf8");
    await symlink(join(project, ".git", "assets"), join(project, "alias"), "dir");

    await expect(
      resolveProjectFile(project, ".env", { mode: "read", blockedPaths: [".env", ".git"] })
    ).rejects.toThrow(/blocked by project policy/);
    await expect(
      resolveProjectFile(project, "alias/hidden.txt", {
        mode: "read",
        blockedPaths: [".env", ".git"]
      })
    ).rejects.toThrow(/resolved path is blocked/);
  });
});
