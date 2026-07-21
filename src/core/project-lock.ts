import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { vispPath } from "./fs-utils.js";

const LOCK_DIRECTORY = ".project-lock";
const OWNER_FILE = "owner.json";
const DEFAULT_ACQUIRE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const DEFAULT_STALE_AFTER_MS = 30_000;
const SAFE_OWNER_TOKEN = /^[A-Za-z0-9_-]{1,128}$/u;

type ProjectLockOwner = {
  version: 1;
  token: string;
  pid: number;
  acquiredAt: string;
  acquiredAtMs: number;
};

type ActiveLease = { active: boolean };

export type ProjectLockOptions = {
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  staleAfterMs?: number;
};

export class ProjectLockTimeoutError extends Error {
  readonly code = "PROJECT_LOCK_TIMEOUT";

  constructor(lockPath: string, timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the project lock at ${lockPath}.`);
    this.name = "ProjectLockTimeoutError";
  }
}

export class ProjectLockOwnershipError extends Error {
  readonly code = "PROJECT_LOCK_OWNERSHIP_LOST";

  constructor(lockPath: string) {
    super(`Project lock ownership changed before release at ${lockPath}.`);
    this.name = "ProjectLockOwnershipError";
  }
}

const activeLeases = new AsyncLocalStorage<Map<string, ActiveLease>>();

/**
 * Serialize a project transaction across processes. Acquisition is bounded and
 * fails closed: callers never continue an update without owning the lock.
 * Nested transactions in the same async call chain reuse the active lease.
 */
export async function withProjectLock<T>(
  projectPath: string,
  operation: () => Promise<T>,
  options: ProjectLockOptions = {}
): Promise<T> {
  const lockPath = await resolveLockPath(projectPath);
  const inheritedLease = activeLeases.getStore()?.get(lockPath);
  if (inheritedLease?.active) {
    return operation();
  }

  const normalized = normalizeOptions(options);
  const owner = await acquireProjectLock(lockPath, normalized);
  const lease: ActiveLease = { active: true };
  const transactionLeases = new Map(activeLeases.getStore() ?? []);
  transactionLeases.set(lockPath, lease);

  let result!: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await activeLeases.run(transactionLeases, operation);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  lease.active = false;
  try {
    await releaseProjectLock(lockPath, owner.token);
  } catch (releaseError) {
    if (!operationFailed) {
      throw releaseError;
    }
    console.warn(
      `warning: project lock release failed after the transaction error: ${errorMessage(releaseError)}`
    );
  }

  if (operationFailed) {
    throw operationError;
  }
  return result;
}

type NormalizedOptions = {
  acquireTimeoutMs: number;
  retryDelayMs: number;
  staleAfterMs: number;
};

function normalizeOptions(options: ProjectLockOptions): NormalizedOptions {
  return {
    acquireTimeoutMs: duration(options.acquireTimeoutMs, DEFAULT_ACQUIRE_TIMEOUT_MS, "acquireTimeoutMs"),
    retryDelayMs: duration(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, "retryDelayMs"),
    staleAfterMs: duration(options.staleAfterMs, DEFAULT_STALE_AFTER_MS, "staleAfterMs")
  };
}

function duration(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return resolved;
}

async function resolveLockPath(projectPath: string): Promise<string> {
  const absoluteProjectPath = resolve(projectPath);
  const canonicalProjectPath = await realpath(absoluteProjectPath).catch((error: unknown) => {
    if (errno(error) === "ENOENT") {
      return absoluteProjectPath;
    }
    throw error;
  });
  return vispPath(canonicalProjectPath, "hyper", LOCK_DIRECTORY);
}

async function acquireProjectLock(
  lockPath: string,
  options: NormalizedOptions
): Promise<ProjectLockOwner> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + options.acquireTimeoutMs;

  for (;;) {
    const owner = newOwner();
    try {
      await mkdir(lockPath);
      try {
        await writeFile(join(lockPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          flag: "wx"
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return owner;
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        throw error;
      }
    }

    const remainingMs = Math.max(0, deadline - Date.now());
    if (await recoverStaleLock(lockPath, options, remainingMs)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ProjectLockTimeoutError(lockPath, options.acquireTimeoutMs);
    }
    await sleep(Math.min(options.retryDelayMs, Math.max(0, deadline - Date.now())));
  }
}

function newOwner(): ProjectLockOwner {
  const acquiredAtMs = Date.now();
  return {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    acquiredAt: new Date(acquiredAtMs).toISOString(),
    acquiredAtMs
  };
}

async function recoverStaleLock(
  lockPath: string,
  options: NormalizedOptions,
  remainingMs: number
): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return true;
    throw error;
  }

  const owner = await readOwner(lockPath);
  const timestamp = owner?.acquiredAtMs ?? lockStat.mtimeMs;
  if (!Number.isFinite(timestamp) || Date.now() - timestamp < options.staleAfterMs) {
    return false;
  }
  if (owner && isProcessAlive(owner.pid)) {
    return false;
  }

  // An ownerless directory can exist briefly between mkdir and owner-file
  // publication. Observe it twice before treating it as abandoned.
  if (!owner) {
    const observationDelayMs = Math.min(options.retryDelayMs, remainingMs);
    if (observationDelayMs <= 0) return false;
    await sleep(observationDelayMs);
  }
  const currentOwner = await readOwner(lockPath);
  if (owner ? currentOwner?.token !== owner.token : currentOwner !== null) {
    return false;
  }

  const recoveryId = owner?.token ?? `ownerless-${Math.trunc(lockStat.mtimeMs)}`;
  const recoveryPath = `${lockPath}.stale-${recoveryId}`;
  try {
    await rename(lockPath, recoveryPath);
  } catch (error) {
    if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(errno(error) ?? "")) {
      return errno(error) === "ENOENT";
    }
    throw error;
  }

  const recoveredOwner = await readOwner(recoveryPath);
  if (owner && recoveredOwner?.token !== owner.token) {
    await restoreUnexpectedOwner(recoveryPath, lockPath);
    return false;
  }
  await rm(recoveryPath, { recursive: true, force: true });
  return true;
}

async function restoreUnexpectedOwner(recoveryPath: string, lockPath: string): Promise<void> {
  try {
    await rename(recoveryPath, lockPath);
  } catch {
    // Do not delete an owner whose token changed during recovery. Leaving the
    // recovery directory behind is safer than guessing which process owns it.
  }
}

async function releaseProjectLock(lockPath: string, token: string): Promise<void> {
  const owner = await readOwner(lockPath);
  if (owner?.token !== token) {
    throw new ProjectLockOwnershipError(lockPath);
  }
  await rm(lockPath, { recursive: true, force: false });
}

async function readOwner(lockPath: string): Promise<ProjectLockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, OWNER_FILE), "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errno(error) ?? "")) return null;
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<ProjectLockOwner>;
    const parsedAcquiredAt =
      typeof value.acquiredAt === "string" ? Date.parse(value.acquiredAt) : Number.NaN;
    if (
      value.version !== 1 ||
      typeof value.token !== "string" ||
      !SAFE_OWNER_TOKEN.test(value.token) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      !Number.isFinite(parsedAcquiredAt) ||
      !Number.isSafeInteger(value.acquiredAtMs) ||
      (value.acquiredAtMs ?? 0) < 0 ||
      parsedAcquiredAt !== value.acquiredAtMs
    ) {
      return null;
    }
    return value as ProjectLockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) !== "ESRCH";
  }
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
