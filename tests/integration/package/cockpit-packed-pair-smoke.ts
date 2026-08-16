import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workspaceRoot = dirname(packageRoot);
const kitRoot = join(workspaceRoot, "visp-kit");
const healthyFixture = join(packageRoot, "fixtures", "cockpit", "healthy");
const siblingKitManifest = join(kitRoot, "package.json");
// Cockpit imports `visp-kit/artifacts`, which the sibling's exports map resolves
// to its built `dist/`. We deliberately do not build another repository from
// here, so an unbuilt sibling has to announce itself instead of surfacing as a
// module-resolution crash inside a spawned child.
const siblingKitArtifacts = join(kitRoot, "dist", "artifacts.js");

const PHASE_9_SCREEN_IDS = [
  "now",
  "feature",
  "scope",
  "assurance",
  "review",
  "runs",
  "memory",
  "health",
  "reference"
] as const;

type PackedPackage = Readonly<{
  filename: string;
  name: string;
  version: string;
}>;

type ProcessExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

type HttpResponse = Readonly<{
  statusCode: number;
  body: string;
}>;

async function runFile(
  executable: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }> = {}
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  return await new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeout ?? 300_000
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `${executable} ${args.join(" ")} failed: ${stderr.trim() || error.message}`,
              { cause: error }
            )
          );
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function packRepository(repositoryRoot: string, destination: string): Promise<PackedPackage> {
  const packEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_offline: "true"
  };
  const { stdout } = await runFile(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
    { cwd: repositoryRoot, env: packEnvironment }
  );
  const packed = parsePackOutput(stdout);
  expect(packed).toHaveLength(1);
  expect(packed[0]!.filename).toMatch(/\.tgz$/u);
  return packed[0]!;
}

function parsePackOutput(stdout: string): PackedPackage[] {
  for (let index = stdout.lastIndexOf("["); index >= 0; index = stdout.lastIndexOf("[", index - 1)) {
    try {
      const candidate = JSON.parse(stdout.slice(index)) as unknown;
      if (
        Array.isArray(candidate) &&
        candidate.every(
          (entry) =>
            entry !== null &&
            typeof entry === "object" &&
            typeof (entry as Record<string, unknown>).filename === "string"
        )
      ) {
        return candidate as PackedPackage[];
      }
    } catch {
      // npm may write progress before its final JSON payload.
    }
  }
  throw new Error("npm pack did not return its JSON package description.");
}

async function extractPackage(tarball: string, packageDirectory: string): Promise<void> {
  await mkdir(packageDirectory, { recursive: true });
  await runFile("tar", ["-xzf", tarball, "-C", packageDirectory, "--strip-components=1"]);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function copyRuntimeDependencies(
  fixtureNodeModules: string,
  sourceRoots: readonly string[]
): Promise<void> {
  const dependencyNames = new Set<string>();
  for (const packageName of ["visp-kit", "visp-hyper-agent"]) {
    const manifest = await readJson(join(fixtureNodeModules, packageName, "package.json"));
    const dependencies = manifest.dependencies;
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const dependencyName of Object.keys(dependencies)) dependencyNames.add(dependencyName);
  }

  for (const dependencyName of [...dependencyNames].sort()) {
    let sourcePath: string | undefined;
    for (const sourceRoot of sourceRoots) {
      const candidate = join(sourceRoot, "node_modules", dependencyName);
      try {
        await access(candidate);
        sourcePath = await realpath(candidate);
        break;
      } catch {
        // Try the other repository's already-installed production dependency.
      }
    }
    if (sourcePath === undefined) {
      throw new Error(`Local runtime dependency ${dependencyName} is unavailable for packed smoke.`);
    }
    const destination = join(fixtureNodeModules, dependencyName);
    await mkdir(dirname(destination), { recursive: true });
    await cp(sourcePath, destination, { recursive: true, force: true });
  }
}

function isolatedChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
}

async function waitForCockpitUrl(
  child: ChildProcess,
  stderr: () => string,
  timeoutMs = 20_000
): Promise<URL> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for packed Cockpit URL. stderr: ${stderr()}`));
    }, timeoutMs);

    const finish = (error?: Error, url?: URL): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onStdout);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error !== undefined) reject(error);
      else resolve(url!);
    };
    const onStdout = (chunk: Buffer | string): void => {
      stdout += String(chunk);
      const match = /Cockpit:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/u.exec(stdout);
      if (match !== null) finish(undefined, new URL(match[1]!));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(
        new Error(
          `Packed Cockpit exited before startup (code=${String(code)}, signal=${String(signal)}). stderr: ${stderr()}`
        )
      );
    };
    const onError = (error: Error): void => finish(error);

    child.stdout?.on("data", onStdout);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function requestState(cockpitUrl: URL): Promise<HttpResponse> {
  const token = cockpitUrl.searchParams.get("token");
  if (token === null || token.length === 0) throw new Error("Cockpit URL omitted its session token.");

  return await new Promise((resolve, reject) => {
    const stateRequest = request(
      {
        hostname: cockpitUrl.hostname,
        port: cockpitUrl.port,
        path: "/api/state",
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    stateRequest.setTimeout(10_000, () => {
      stateRequest.destroy(new Error("Timed out requesting packed Cockpit state."));
    });
    stateRequest.once("error", reject);
    stateRequest.end();
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for packed Cockpit to exit."));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function terminateChild(child: ChildProcess): Promise<ProcessExit> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill("SIGTERM");
  try {
    return await waitForExit(child, 10_000);
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
    throw error;
  }
}

describe("packed Kit and Hyper Cockpit compatibility", () => {
  if (!existsSync(siblingKitManifest)) {
    it.skip("requires sibling ../visp-kit; skipped because its package.json is absent", () => {});
    return;
  }

  // This suite packs the repository and boots the extracted tarball's
  // `dist/index.js`, so `dist/` must exist before `npm pack` reads the disk.
  // The suite-wide `globalSetup` (tests/setup/build-dist.ts) has built it
  // before any test file is collected, so ordering cannot affect this result.
  //
  // The SIBLING's build is a different matter: this package will not build
  // another repository, so an unbuilt ../visp-kit is reported, loudly, here.
  beforeAll(async () => {
    if (!existsSync(siblingKitArtifacts)) {
      throw new Error(
        `Sibling ../visp-kit is present but unbuilt: ${siblingKitArtifacts} is missing, ` +
          "and Cockpit resolves `visp-kit/artifacts` to it. Run `pnpm build` in visp-kit, " +
          "then rerun. This is reported rather than repaired because building another " +
          "repository from this suite is not this package's to do."
      );
    }
  }, 320_000);

  it(
    "serves the healthy nine-screen Cockpit using only manually extracted package tarballs",
    async () => {
      const temporaryRoot = await mkdtemp(join(tmpdir(), "visp-cockpit-packed-pair-"));
      let child: ChildProcess | undefined;
      let stderr = "";
      try {
        const tarballDirectory = join(temporaryRoot, "tarballs");
        const fixtureRoot = join(temporaryRoot, "fixture");
        const fixtureNodeModules = join(fixtureRoot, "node_modules");
        const projectPath = join(fixtureRoot, "healthy-project");
        await mkdir(tarballDirectory, { recursive: true });

        const [kitPackage, hyperPackage] = await Promise.all([
          packRepository(kitRoot, tarballDirectory),
          packRepository(packageRoot, tarballDirectory)
        ]);
        expect(kitPackage.name).toBe("visp-kit");
        expect(hyperPackage.name).toBe("visp-hyper-agent");

        await extractPackage(
          join(tarballDirectory, kitPackage.filename),
          join(fixtureNodeModules, "visp-kit")
        );
        await extractPackage(
          join(tarballDirectory, hyperPackage.filename),
          join(fixtureNodeModules, "visp-hyper-agent")
        );
        await copyRuntimeDependencies(fixtureNodeModules, [packageRoot, kitRoot]);
        await cp(healthyFixture, projectPath, { recursive: true, force: true });

        const hyperCli = join(fixtureNodeModules, "visp-hyper-agent", "dist", "index.js");
        child = spawn(process.execPath, [hyperCli, "--project", projectPath, "cockpit"], {
          cwd: fixtureRoot,
          env: isolatedChildEnvironment(),
          stdio: ["ignore", "pipe", "pipe"]
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += String(chunk);
        });

        const cockpitUrl = await waitForCockpitUrl(child, () => stderr);
        expect(cockpitUrl.protocol).toBe("http:");
        expect(cockpitUrl.hostname).toBe("127.0.0.1");
        expect(cockpitUrl.pathname).toBe("/");
        expect(cockpitUrl.searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]+$/u);

        const response = await requestState(cockpitUrl);
        expect(response.statusCode).toBe(200);
        const state = JSON.parse(response.body) as Record<string, unknown>;
        expect(state.apiVersion).toBe("1.0");
        expect(Object.keys(state.screens as Record<string, unknown>)).toEqual(PHASE_9_SCREEN_IDS);

        const screens = state.screens as Record<string, Record<string, unknown>>;
        expect(screens.now).toEqual({
          id: "now",
          label: "Now",
          artifacts: [
            {
              id: "project-status",
              label: "Project status",
              state: "present",
              sourcePath: ".visp/status.json",
              values: [
                { label: "Initialized", value: true, sourcePath: ".visp/status.json" },
                { label: "Active feature ID", value: "001", sourcePath: ".visp/status.json" },
                { label: "Active feature slug", value: "cockpit", sourcePath: ".visp/status.json" },
                {
                  label: "Active feature path",
                  value: ".visp/features/001-cockpit",
                  sourcePath: ".visp/status.json"
                },
                { label: "Active task ID", value: "T001", sourcePath: ".visp/status.json" },
                { label: "Current state", value: "verified", sourcePath: ".visp/status.json" },
                { label: "Last command label", value: "verify", sourcePath: ".visp/status.json" },
                {
                  label: "Updated at",
                  value: "2026-08-01T00:10:00.000Z",
                  sourcePath: ".visp/status.json"
                }
              ]
            }
          ]
        });

        const exit = await terminateChild(child);
        expect(exit).toEqual({ code: 0, signal: null });
      } finally {
        if (child !== undefined) await terminateChild(child).catch(() => undefined);
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    360_000
  );
});
