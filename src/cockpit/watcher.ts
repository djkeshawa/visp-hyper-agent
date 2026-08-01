import { watch, type FSWatcher, type WatchEventType } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export type CockpitWatcherOptions = Readonly<{
  projectPath: string;
  onInvalidate: (repositoryRelativePath: string) => void;
  onError?: (error: Error) => void;
  coalesceMs?: number;
  retryMs?: number;
  watchFactory?: CockpitWatchFactory;
}>;

export type CockpitWatchFactory = (
  path: string,
  options: Readonly<{ encoding: "utf8"; recursive?: boolean }>,
  listener: (eventType: WatchEventType, filename: string | null) => void
) => FSWatcher;

export type CockpitWatcher = Readonly<{
  projectRealPath: string;
  close: () => Promise<void>;
}>;

export async function startCockpitWatcher(
  options: CockpitWatcherOptions
): Promise<CockpitWatcher> {
  const coalesceMs = options.coalesceMs ?? 50;
  if (!Number.isSafeInteger(coalesceMs) || coalesceMs < 0 || coalesceMs > 10_000) {
    throw new TypeError("Cockpit watcher coalesceMs must be an integer from 0 through 10000.");
  }
  const retryMs = options.retryMs ?? 1_000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 60_000) {
    throw new TypeError("Cockpit watcher retryMs must be an integer from 1 through 60000.");
  }
  const watchFactory: CockpitWatchFactory =
    options.watchFactory ??
    ((watchPath, watchOptions, listener) => watch(watchPath, watchOptions, listener));

  const projectRealPath = await realpath(options.projectPath);
  const projectInfo = await lstat(projectRealPath);
  if (!projectInfo.isDirectory()) {
    throw new TypeError("Cockpit watcher projectPath must resolve to a directory.");
  }

  const artifactRoot = join(projectRealPath, ".visp");
  const pendingInvalidations = new Map<string, ReturnType<typeof setTimeout>>();
  let rootWatcher: FSWatcher | undefined;
  let artifactWatcher: FSWatcher | undefined;
  let artifactRootPresent = false;
  let initialReconcileComplete = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let reconcileQueue = Promise.resolve();

  const reportError = (error: unknown): void => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    try {
      options.onError?.(normalized);
    } catch {
      // A diagnostic callback must not disable watcher recovery.
    }
  };

  const queueInvalidation = (repositoryRelativePath: string): void => {
    if (closed) return;
    const prior = pendingInvalidations.get(repositoryRelativePath);
    if (prior !== undefined) clearTimeout(prior);
    const timer = setTimeout(() => {
      pendingInvalidations.delete(repositoryRelativePath);
      if (closed) return;
      try {
        options.onInvalidate(repositoryRelativePath);
      } catch (error) {
        reportError(error);
      }
    }, coalesceMs);
    pendingInvalidations.set(repositoryRelativePath, timer);
  };

  const closeArtifactWatcher = (): void => {
    const watcher = artifactWatcher;
    artifactWatcher = undefined;
    watcher?.close();
  };

  const closeRootWatcher = (): void => {
    const watcher = rootWatcher;
    rootWatcher = undefined;
    watcher?.close();
  };

  let scheduleReconcile: (forceArtifactReopen: boolean, invalidateAfter?: boolean) => void;
  let scheduleRecovery: () => void;

  const openRootWatcher = (): void => {
    if (rootWatcher !== undefined || closed) return;
    const watcher = watchFactory(
      projectRealPath,
      { encoding: "utf8" },
      (_eventType, filename) => {
        if (rootEventMayAffectArtifactRoot(filename)) scheduleReconcile(true);
      }
    );
    if (closed) {
      watcher.close();
      return;
    }
    rootWatcher = watcher;
    watcher.on("error", (error) => {
      if (closed || rootWatcher !== watcher) return;
      rootWatcher = undefined;
      watcher.close();
      closeArtifactWatcher();
      reportError(error);
      scheduleRecovery();
    });
  };

  const reconcileArtifactWatcher = async (forceReopen: boolean): Promise<void> => {
    if (closed) return;

    let present = false;
    try {
      const info = await lstat(artifactRoot);
      present = info.isDirectory() && !info.isSymbolicLink();
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }

    const changed = initialReconcileComplete && present !== artifactRootPresent;
    artifactRootPresent = present;
    initialReconcileComplete = true;
    if (changed) queueInvalidation(".visp");

    if (!present) {
      closeArtifactWatcher();
      return;
    }
    if (forceReopen) closeArtifactWatcher();
    if (artifactWatcher !== undefined || closed) return;

    let watcher: FSWatcher;
    try {
      watcher = watchFactory(
        artifactRoot,
        { encoding: "utf8", recursive: true },
        (_eventType, filename) => {
          const invalidationPath = artifactInvalidationPath(filename);
          if (invalidationPath !== undefined) queueInvalidation(invalidationPath);
        }
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        artifactRootPresent = false;
        return;
      }
      throw error;
    }

    if (closed) {
      watcher.close();
      return;
    }
    artifactWatcher = watcher;
    watcher.on("error", (error) => {
      if (closed || artifactWatcher !== watcher) return;
      artifactWatcher = undefined;
      watcher.close();
      reportError(error);
      scheduleRecovery();
    });
  };

  scheduleRecovery = (): void => {
    if (closed || retryTimer !== undefined) return;
    queueInvalidation(".visp");
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (closed) return;
      scheduleReconcile(true, true);
    }, retryMs);
    retryTimer.unref();
  };

  scheduleReconcile = (forceReopen: boolean, invalidateAfter = false): void => {
    reconcileQueue = reconcileQueue
      .then(async () => {
        if (closed) return;
        openRootWatcher();
        await reconcileArtifactWatcher(forceReopen);
        if (invalidateAfter) queueInvalidation(".visp");
      })
      .catch((error) => {
        if (closed) return;
        closeArtifactWatcher();
        reportError(error);
        scheduleRecovery();
      });
  };

  try {
    openRootWatcher();
    await reconcileArtifactWatcher(false);
  } catch (error) {
    closeRootWatcher();
    closeArtifactWatcher();
    throw error;
  }

  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    closeRootWatcher();
    closeArtifactWatcher();
    for (const timer of pendingInvalidations.values()) clearTimeout(timer);
    pendingInvalidations.clear();
    closePromise = reconcileQueue.then(() => {
      closeArtifactWatcher();
    });
    return closePromise;
  };

  return Object.freeze({ projectRealPath, close });
}

function rootEventMayAffectArtifactRoot(filename: string | null): boolean {
  if (filename === null) return true;
  const parts = filename.split(/[\\/]+/u).filter(Boolean);
  return parts[0] === ".visp";
}

function artifactInvalidationPath(filename: string | null): string | undefined {
  if (filename === null) return ".visp";
  if (isAbsolute(filename)) return ".visp";

  const parts = filename.split(/[\\/]+/u).filter((part) => part.length > 0 && part !== ".");
  if (parts[0] === ".visp") parts.shift();
  if (parts.includes("..")) return ".visp";
  if (parts[0] === "cache") return undefined;
  return parts.length === 0 ? ".visp" : `.visp/${parts.join("/")}`;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
