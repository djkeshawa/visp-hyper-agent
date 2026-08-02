import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startCockpitServerMock } = vi.hoisted(() => ({
  startCockpitServerMock: vi.fn()
}));

vi.mock("../src/cockpit/server.js", () => ({
  startCockpitServer: startCockpitServerMock
}));

import { runCli } from "../src/cli/index.js";

type TerminationSignal = "SIGINT" | "SIGTERM";
type SignalListener = (...args: unknown[]) => void;

const terminationSignals = ["SIGINT", "SIGTERM"] as const;

let logs: string[];
let signalListenersBeforeTest: Record<TerminationSignal, Set<SignalListener>>;

function signalListeners(signal: TerminationSignal): SignalListener[] {
  return process.listeners(signal) as SignalListener[];
}

function addedSignalListeners(signal: TerminationSignal): SignalListener[] {
  return signalListeners(signal).filter(
    (listener) => !signalListenersBeforeTest[signal].has(listener)
  );
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

beforeEach(() => {
  logs = [];
  signalListenersBeforeTest = {
    SIGINT: new Set(signalListeners("SIGINT")),
    SIGTERM: new Set(signalListeners("SIGTERM"))
  };
  startCockpitServerMock.mockReset();
  vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
});

afterEach(() => {
  for (const signal of terminationSignals) {
    for (const listener of addedSignalListeners(signal)) {
      process.off(signal, listener);
    }
  }
  vi.restoreAllMocks();
});

describe("cockpit command", () => {
  it("resolves the global project, prints the token URL, and awaits one clean shutdown", async () => {
    const closeResult = deferred<void>();
    const close = vi.fn(() => closeResult.promise);
    const url = "http://127.0.0.1:43117/?token=session-token";
    startCockpitServerMock.mockResolvedValue({
      host: "127.0.0.1",
      port: 43117,
      url,
      token: "session-token",
      close
    });

    const projectArgument = "fixtures/cockpit-project";
    const commandResult = runCli([
      "node",
      "visp-hyper",
      "--project",
      projectArgument,
      "cockpit"
    ]);
    let commandSettled = false;
    void commandResult.then(
      () => {
        commandSettled = true;
      },
      () => {
        commandSettled = true;
      }
    );

    await vi.waitFor(() => {
      expect(startCockpitServerMock).toHaveBeenCalledOnce();
      expect(addedSignalListeners("SIGINT")).toHaveLength(1);
      expect(addedSignalListeners("SIGTERM")).toHaveLength(1);
    });

    expect(startCockpitServerMock).toHaveBeenCalledWith({
      projectPath: resolve(projectArgument)
    });
    expect(logs).toEqual([
      `Cockpit: ${url}`,
      "Press Ctrl-C to stop the local read-only server."
    ]);
    expect(commandSettled).toBe(false);

    const onSigint = addedSignalListeners("SIGINT")[0];
    const onSigterm = addedSignalListeners("SIGTERM")[0];
    onSigint();
    onSigterm();

    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(commandSettled).toBe(false);

    closeResult.resolve();
    await commandResult;

    expect(close).toHaveBeenCalledOnce();
    expect(addedSignalListeners("SIGINT")).toEqual([]);
    expect(addedSignalListeners("SIGTERM")).toEqual([]);
  });

  it("propagates startup failures without output or signal listeners", async () => {
    const startupError = new Error("listener unavailable");
    startCockpitServerMock.mockRejectedValueOnce(startupError);

    await expect(
      runCli(["node", "visp-hyper", "--project", "broken-project", "cockpit"])
    ).rejects.toBe(startupError);

    expect(logs).toEqual([]);
    expect(addedSignalListeners("SIGINT")).toEqual([]);
    expect(addedSignalListeners("SIGTERM")).toEqual([]);
  });

  it("propagates close failures after removing both signal listeners", async () => {
    const closeError = new Error("shutdown failed");
    const close = vi.fn().mockRejectedValue(closeError);
    startCockpitServerMock.mockResolvedValue({
      host: "127.0.0.1",
      port: 43118,
      url: "http://127.0.0.1:43118/?token=close-error-token",
      token: "close-error-token",
      close
    });

    const commandResult = runCli(["node", "visp-hyper", "cockpit"]);
    const rejected = expect(commandResult).rejects.toBe(closeError);

    await vi.waitFor(() => expect(addedSignalListeners("SIGTERM")).toHaveLength(1));
    addedSignalListeners("SIGTERM")[0]();

    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(addedSignalListeners("SIGINT")).toEqual([]);
    expect(addedSignalListeners("SIGTERM")).toEqual([]);
  });

  it("lists cockpit in the root help", async () => {
    let helpOutput = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      helpOutput += String(chunk);
      return true;
    });
    const helpExit = new Error("help exit");
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw helpExit;
    });

    await expect(runCli(["node", "visp-hyper", "--help"])).rejects.toBe(helpExit);

    expect(helpOutput).toMatch(/^\s+cockpit\s+Serve the read-only local Cockpit/mu);
    expect(startCockpitServerMock).not.toHaveBeenCalled();
  });

  it("owns the visp binary with visp-hyper as an alias (P10-US-05, ADR 0005)", async () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      bin?: Record<string, string>;
    };

    // The final dispatcher release: Kit released the `visp` name (Kit ADR
    // 0005) and this package now provides it, with `visp-hyper` as an alias.
    // Publication ordering (D-118) keeps the two from ever colliding on npm.
    expect(packageJson.bin).toEqual({
      visp: "dist/index.js",
      "visp-hyper": "dist/index.js"
    });
  });
});
