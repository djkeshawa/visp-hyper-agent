import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withStoreLock } from "../../../src/core/store-lock.js";
import { appendUsage, readTelemetry } from "../../../src/telemetry/telemetry-store.js";

async function createProject(): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), "visp-lock-"));
  await mkdir(join(projectPath, ".visp", "hyper"), { recursive: true });
  return projectPath;
}

describe("withStoreLock", () => {
  it("serializes concurrent read-modify-write cycles", async () => {
    const projectPath = await createProject();
    const counterPath = join(projectPath, ".visp", "hyper", "counter.json");
    await writeFile(counterPath, "0", "utf8");

    const bump = () =>
      withStoreLock(projectPath, async () => {
        const current = Number(await readFile(counterPath, "utf8"));
        // Yield so unserialized racers would read the same stale value.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await writeFile(counterPath, String(current + 1), "utf8");
      });

    await Promise.all(Array.from({ length: 10 }, bump));
    expect(Number(await readFile(counterPath, "utf8"))).toBe(10);
  });

  it("releases the lock when the callback throws", async () => {
    const projectPath = await createProject();
    await expect(
      withStoreLock(projectPath, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // A held lock would stall this for the full acquire timeout.
    const start = Date.now();
    await withStoreLock(projectPath, async () => {});
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("steals a stale lock left by a dead process", async () => {
    const projectPath = await createProject();
    const lockPath = join(projectPath, ".visp", "hyper", ".store-lock");
    await mkdir(lockPath);
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    let ran = false;
    await withStoreLock(projectPath, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("keeps concurrent telemetry appends intact", async () => {
    const projectPath = await createProject();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        appendUsage(projectPath, { sessionId: `s${index}`, inputTokens: index })
      )
    );
    const { data } = await readTelemetry(projectPath);
    expect(data.usage).toHaveLength(8);
  });
});
