import { mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { vispPath } from "./fs-utils.js";

const RETRY_MS = 25;
const ACQUIRE_TIMEOUT_MS = 5_000;
// A holder that dies without releasing leaves the lock dir behind; anything
// older than this is treated as abandoned. Store mutations take milliseconds,
// so seconds of age can only mean a crashed process.
const STALE_MS = 15_000;

/**
 * Serialize read-modify-write cycles on the .visp/hyper/*.json stores across
 * concurrent visp-hyper invocations on the same host (fan-out subagents, MCP
 * server calls). One project-wide lock: a `mkdir`-based lock directory, which
 * is atomic on every platform and needs no dependencies. DEGRADE, NEVER
 * CRASH: if the lock cannot be acquired within the timeout, the mutation
 * proceeds unlocked with a warning — last-writer-wins was the previous
 * behavior everywhere, so a missed lock is never worse than the status quo.
 */
export async function withStoreLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = vispPath(projectPath, "hyper", ".store-lock");
  const acquired = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    if (acquired) {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {
        // Releasing is best-effort; a leftover dir ages into staleness.
      });
    }
  }
}

async function acquireLock(lockPath: string): Promise<boolean> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  await mkdir(dirname(lockPath), { recursive: true }).catch(() => {
    // Parent creation failures surface on the mkdir below.
  });
  // Clearing an abandoned lock earns one immediate retry, because the next
  // mkdir normally wins it. Every later pass waits and re-reads the deadline:
  // `removeIfStale` also reports true when its `rm` quietly failed (a foreign
  // owner, a read-only parent), and retrying that on a bare `continue` spun
  // the CPU forever with the timeout never consulted.
  let retriedWithoutWaiting = false;
  for (;;) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        console.warn(
          `warning: store lock unavailable (${error instanceof Error ? error.message : String(error)}); proceeding without it`
        );
        return false;
      }
    }
    const clearedStaleLock = await removeIfStale(lockPath);
    if (Date.now() >= deadline) {
      console.warn("warning: store lock held too long by another process; proceeding without it");
      return false;
    }
    if (clearedStaleLock && !retriedWithoutWaiting) {
      retriedWithoutWaiting = true;
      continue;
    }
    retriedWithoutWaiting = false;
    await sleep(RETRY_MS);
  }
}

async function removeIfStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < STALE_MS) {
      return false;
    }
  } catch {
    // Already released by the holder; retry the acquire immediately.
    return true;
  }
  await rm(lockPath, { recursive: true, force: true }).catch(() => {
    // Another waiter may have removed it first; either way, retry.
  });
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
