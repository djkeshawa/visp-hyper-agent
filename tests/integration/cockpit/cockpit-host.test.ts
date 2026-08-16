import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COCKPIT_KIT_ARTIFACTS_MODULE_ID,
  loadCockpitKitArtifacts
} from "../../../src/cockpit/kit-artifacts.js";
import {
  startCockpitServer,
  type StartCockpitServerOptions
} from "../../../src/cockpit/server.js";
import {
  createTestArtifactReader,
  createTestReviewDecisionHash,
  testArtifactSchemas
} from "../../helpers/cockpit-kit-artifacts.js";

type CockpitServer = Awaited<ReturnType<typeof startCockpitServer>>;

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

type RequestOptions = {
  method?: string;
  token?: string | null;
  hostHeader?: string;
};

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "cockpit");
const testKitArtifactsModule = Object.freeze({
  artifactSchemas: testArtifactSchemas,
  createArtifactReader: createTestArtifactReader
});
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
const openServers: CockpitServer[] = [];
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(openServers.splice(0).map((server) => server.close()));
  await Promise.allSettled(
    [...temporaryDirectories].map((path) => rm(path, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

async function copyFixture(name: string): Promise<string> {
  const projectPath = await mkdtemp(join(tmpdir(), `visp-cockpit-${name}-`));
  temporaryDirectories.add(projectPath);
  await cp(join(fixtureRoot, name), projectPath, { recursive: true, force: true });
  return projectPath;
}

async function start(
  projectPath: string,
  input: Omit<
    StartCockpitServerOptions,
    "projectPath" | "port" | "kitArtifacts" | "loadKitModule"
  > = {}
): Promise<CockpitServer> {
  const server = await startCockpitServer({
    projectPath,
    port: 0,
    loadKitModule: async (specifier) => {
      expect(specifier).toBe(COCKPIT_KIT_ARTIFACTS_MODULE_ID);
      return testKitArtifactsModule;
    },
    ...input
  });
  openServers.push(server);
  return server;
}

function httpRequest(
  server: CockpitServer,
  pathname: string,
  options: RequestOptions = {}
): Promise<HttpResult> {
  const url = new URL(pathname, server.url);
  const token = options.token === undefined ? server.token : options.token;
  const headers: Record<string, string> = {
    Host: options.hostHeader ?? `127.0.0.1:${server.port}`
  };
  if (token !== null) headers.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        method: options.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function parseJson(result: HttpResult): unknown {
  expect(result.headers["content-type"]).toContain("application/json");
  return JSON.parse(result.body) as unknown;
}

function contentSecurityPolicy(headers: IncomingHttpHeaders): Map<string, string[]> {
  const header = headers["content-security-policy"];
  expect(header, "Cockpit HTML must carry a Content-Security-Policy header").toBeDefined();
  const value = Array.isArray(header) ? header.join(";") : (header ?? "");
  return new Map(
    value
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter((parts) => parts[0]?.length)
      .map(([name, ...sources]) => [name!.toLowerCase(), sources])
  );
}

function staticResourcePaths(html: string): string[] {
  return [...html.matchAll(/<(?:script|link|img|source)\b[^>]*(?:src|href)=["']([^"']+)["']/giu)]
    .map((match) => match[1]!)
    .filter((path) => path.startsWith("/") && !path.startsWith("//"));
}

function visibleText(fragment: string): string {
  return fragment.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function navigationLabels(html: string): string[] {
  const nav = /<nav\b[^>]*>[\s\S]*?<\/nav>/iu.exec(html)?.[0];
  expect(nav, "Cockpit must expose its screens through a navigation landmark").toBeDefined();
  return [...(nav ?? "").matchAll(/<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/giu)]
    .map((match) => visibleText(match[1]!))
    .filter(Boolean);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(path: string, relative: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(path, entry.name);
      const entryRelative = join(relative, entry.name);
      const info = await stat(entryPath);
      if (entry.isDirectory()) {
        snapshot[`${entryRelative}/`] = `directory:${info.mode}:${info.mtimeMs}`;
        await visit(entryPath, entryRelative);
      } else {
        const bytes = await readFile(entryPath);
        snapshot[entryRelative] = [
          "file",
          info.mode,
          info.size,
          info.mtimeMs,
          createHash("sha256").update(bytes).digest("hex")
        ].join(":");
      }
    }
  }

  await visit(root, "");
  return snapshot;
}

async function openSse(
  server: CockpitServer,
  token = server.token
): Promise<{ response: IncomingMessage; messages: string[] }> {
  const messages: string[] = [];
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: `/api/events?token=${encodeURIComponent(token)}`,
        headers: {
          Accept: "text/event-stream",
          Host: `127.0.0.1:${server.port}`
        }
      },
      resolve
    );
    req.on("error", reject);
    req.end();
  });

  response.setEncoding("utf8");
  let buffered = "";
  response.on("data", (chunk: string) => {
    buffered += chunk.replaceAll("\r\n", "\n");
    const records = buffered.split("\n\n");
    buffered = records.pop() ?? "";
    for (const record of records) {
      const data = record
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data.length > 0) messages.push(data);
    }
  });

  return { response, messages };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Cockpit event.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value === null || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(objects)];
}

function phase9Screens(value: unknown): Map<string, Record<string, unknown>> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  const candidate = (value as Record<string, unknown>).screens;
  const screens = new Map<string, Record<string, unknown>>();

  expect(candidate).not.toBeNull();
  expect(typeof candidate).toBe("object");
  expect(Array.isArray(candidate), "screens must be the versioned ID-keyed map").toBe(false);
  expect(Object.keys(candidate as Record<string, unknown>)).toEqual([...PHASE_9_SCREEN_IDS]);
  for (const [id, entry] of Object.entries(candidate as Record<string, unknown>)) {
    expect(entry).not.toBeNull();
    expect(typeof entry).toBe("object");
    const screen = entry as Record<string, unknown>;
    expect(screen.id).toBe(id);
    expect(typeof screen.label).toBe("string");
    expect(Array.isArray(screen.artifacts)).toBe(true);
    expect((screen.artifacts as unknown[]).length).toBeGreaterThan(0);
    for (const aggregateField of ["state", "sourcePath", "expectedPath", "reason"]) {
      expect(
        screen[aggregateField],
        `${id} must not expose aggregate ${aggregateField}`
      ).toBeUndefined();
    }
    screens.set(id, screen);
  }

  return screens;
}

const ALL_ARTIFACT_IDS = [
  "project-status",
  "project-profile",
  "project-config",
  "policy",
  "workflow",
  "run-index",
  "constitution",
  "patterns",
  "project-summary",
  "doctor-report",
  "feature-intent",
  "specification",
  "plan",
  "task-graph",
  "verification",
  "task-review",
  "assurance-case",
  "review-decision-pointer",
  "review-decision"
] as const;

const SCREEN_DEGRADED_CASES = [
  {
    artifactId: "project-status",
    relativePath: ".visp/status.json",
    format: "json",
    screens: ["now"]
  },
  {
    artifactId: "feature-intent",
    relativePath: ".visp/features/001-cockpit/intent.json",
    format: "json",
    screens: ["feature"]
  },
  {
    artifactId: "verification",
    relativePath: ".visp/features/001-cockpit/verification.json",
    format: "json",
    screens: ["scope", "assurance"]
  },
  {
    artifactId: "review-decision-pointer",
    relativePath: ".visp/features/001-cockpit/assurance/T001/review-decision.json",
    format: "json",
    screens: ["review"]
  },
  {
    artifactId: "run-index",
    relativePath: ".visp/runs/index.json",
    format: "json",
    screens: ["runs"]
  },
  {
    artifactId: "project-summary",
    relativePath: ".visp/memory/project-summary.md",
    format: "text",
    screens: ["memory"]
  },
  {
    artifactId: "doctor-report",
    relativePath: ".visp/reports/doctor-report.md",
    format: "text",
    screens: ["health"]
  },
  {
    artifactId: "project-profile",
    relativePath: ".visp/project.json",
    format: "json",
    screens: ["reference"]
  }
] as const;

type ArtifactState =
  | "present"
  | "uninitialized"
  | "missing"
  | "stale"
  | "corrupt"
  | "unavailable";

function assertArtifactContract(artifact: Record<string, unknown>): void {
  expect(typeof artifact.id).toBe("string");
  expect(String(artifact.id).trim().length).toBeGreaterThan(0);
  expect(typeof artifact.label).toBe("string");
  expect(String(artifact.label).trim().length).toBeGreaterThan(0);
  expect([
    "present",
    "uninitialized",
    "missing",
    "stale",
    "corrupt",
    "unavailable"
  ]).toContain(artifact.state);

  if (artifact.state === "present") {
    expect(typeof artifact.sourcePath).toBe("string");
    expect(String(artifact.sourcePath)).toMatch(/^\.visp\//u);
    expect(Array.isArray(artifact.values)).toBe(true);
    expect((artifact.values as unknown[]).length).toBeGreaterThan(0);
    for (const value of artifact.values as Array<Record<string, unknown>>) {
      expect(value.sourcePath).toBe(artifact.sourcePath);
      expect(typeof value.label).toBe("string");
      expect(value).toHaveProperty("value");
    }
    return;
  }

  expect(typeof artifact.reason).toBe("string");
  expect(String(artifact.reason).trim().length).toBeGreaterThan(0);
  expect(typeof artifact.expectedPath).toBe("string");
  expect(String(artifact.expectedPath)).toMatch(/^\.visp\//u);
  if (artifact.state === "stale" || artifact.state === "corrupt") {
    expect(artifact.sourcePath).toBe(artifact.expectedPath);
  }
}

async function artifactStatesById(
  projectPath: string,
  screens: Map<string, Record<string, unknown>>
): Promise<Record<string, ArtifactState>> {
  const artifacts = new Map<string, Record<string, unknown>>();
  for (const screenId of PHASE_9_SCREEN_IDS) {
    const screenArtifacts = screens.get(screenId)!.artifacts as Array<Record<string, unknown>>;
    for (const artifact of screenArtifacts) {
      assertArtifactContract(artifact);
      const id = String(artifact.id);
      const existing = artifacts.get(id);
      if (existing !== undefined) {
        expect(artifact, `${id} must retain one state across sibling screens`).toEqual(existing);
      } else {
        artifacts.set(id, artifact);
      }
    }
  }

  expect([...artifacts.keys()].sort()).toEqual([...ALL_ARTIFACT_IDS].sort());
  for (const artifact of artifacts.values()) {
    if (artifact.state !== "present") continue;
    const info = await stat(artifactPath(projectPath, String(artifact.sourcePath)));
    expect(info.isFile(), `${artifact.id} cannot present a missing source`).toBe(true);
  }
  return Object.fromEntries(
    [...artifacts].map(([id, artifact]) => [id, artifact.state as ArtifactState])
  );
}

function expectedArtifactStates(
  groups: Partial<Record<ArtifactState, readonly string[]>>
): Record<string, ArtifactState> {
  const states: Record<string, ArtifactState> = {};
  for (const [state, ids] of Object.entries(groups) as Array<
    [ArtifactState, readonly string[]]
  >) {
    for (const id of ids) {
      expect(states[id], `${id} must have exactly one expected state`).toBeUndefined();
      states[id] = state;
    }
  }
  expect(Object.keys(states).sort()).toEqual([...ALL_ARTIFACT_IDS].sort());
  return states;
}

function artifactPath(projectPath: string, path: string): string {
  return isAbsolute(path) ? path : join(projectPath, path);
}

async function writeSchemaValidMismatchedReviewHistory(projectPath: string): Promise<void> {
  const decidedAt = "2026-08-01T00:10:00.000Z";
  const sha256 = `sha256:${"b".repeat(64)}`;
  const decision = {
    version: "1.0",
    featureId: "999",
    featureSlug: "cockpit",
    taskId: "T001",
    assuranceProfile: "behavioral",
    reviewerId: "artifact-reader-regression",
    identityAssurance: "self_declared",
    decision: "accept",
    reason: "Schema-valid history deliberately has the wrong feature identity.",
    reviewedHotspotIds: [],
    assuranceCase: {
      path: ".visp/features/001-cockpit/assurance/T001/assurance-case.json",
      sha256
    },
    codeState: {
      mode: "base_to_workspace",
      baseRevision: "base-revision",
      targetRevision: "WORKTREE",
      snapshotSha256: sha256,
      stateSha256: sha256
    },
    policy: { path: ".visp/policy.json", sha256 },
    freshnessInputs: [],
    supersedesDecisionHash: null,
    decidedAt
  } as const;
  const decisionHash = createTestReviewDecisionHash(decision);
  const digest = decisionHash.slice("sha256:".length);
  const decisionPath = `.visp/features/001-cockpit/assurance/T001/review-decisions/${digest}.json`;

  await mkdir(dirname(artifactPath(projectPath, decisionPath)), { recursive: true });
  await writeFile(
    artifactPath(projectPath, decisionPath),
    `${JSON.stringify({ ...decision, decisionHash }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(
      projectPath,
      ".visp",
      "features",
      "001-cockpit",
      "assurance",
      "T001",
      "review-decision.json"
    ),
    `${JSON.stringify({
      version: "1.0",
      featureId: "001",
      featureSlug: "cockpit",
      taskId: "T001",
      decisionPath,
      decisionHash,
      updatedAt: decidedAt
    }, null, 2)}\n`,
    "utf8"
  );
}

async function writeRunIndex(projectPath: string, count: number): Promise<void> {
  const runs = Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const id = `run-${String(ordinal).padStart(4, "0")}`;
    const minute = String(index % 60).padStart(2, "0");
    const hour = String(Math.floor(index / 60)).padStart(2, "0");
    return {
      id,
      command: `fixture-command-${ordinal}`,
      startedAt: `2026-08-01T${hour}:${minute}:00.000Z`,
      endedAt: `2026-08-01T${hour}:${minute}:30.000Z`,
      success: true,
      result: "passed",
      runPath: `.visp/runs/${id}/run.json`
    };
  });
  await mkdir(join(projectPath, ".visp", "runs"), { recursive: true });
  await writeFile(
    join(projectPath, ".visp", "runs", "index.json"),
    JSON.stringify({ latestRunId: runs.at(-1)?.id ?? null, runs }, null, 2),
    "utf8"
  );
}

function runEvent(runId: string, id: string, message: string): Record<string, unknown> {
  return {
    id,
    runId,
    type: "command_completed",
    command: "fixture-check --opaque 7f3a",
    message,
    createdAt: "2026-08-01T00:02:00.000Z"
  };
}

describe("Cockpit loopback and request security (P9-03)", () => {
  it.each(["0.0.0.0", "::", "::1", "localhost", "192.0.2.1"])(
    "refuses the non-exact bind host %s",
    async (host) => {
      const projectPath = await copyFixture("uninitialized");
      await expect(startCockpitServer({ projectPath, host, port: 0 })).rejects.toThrow(
        /127\.0\.0\.1|loopback/i
      );
    }
  );

  it("binds exactly 127.0.0.1 and reports a matching session URL", async () => {
    const server = await start(await copyFixture("healthy"));
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
  });

  it.skipIf(process.platform === "win32")(
    "pins a symlinked project root to its startup target",
    async () => {
      const firstProject = await copyFixture("healthy");
      const secondProject = await copyFixture("corrupt");
      const linkParent = await mkdtemp(join(tmpdir(), "visp-cockpit-root-link-"));
      temporaryDirectories.add(linkParent);
      const linkedProject = join(linkParent, "project");
      await symlink(firstProject, linkedProject, "dir");
      const server = await start(linkedProject);
      const before = await httpRequest(server, "/api/state");

      await rm(linkedProject);
      await symlink(secondProject, linkedProject, "dir");
      const after = await httpRequest(server, "/api/state");

      expect(before.status).toBe(200);
      expect(after.status).toBe(200);
      expect(after.body).toBe(before.body);
    }
  );

  it.runIf(process.platform === "win32")(
    "keeps a running server's watched project root non-replaceable",
    async () => {
      const parentPath = await mkdtemp(join(tmpdir(), "visp-cockpit-root-windows-"));
      temporaryDirectories.add(parentPath);
      const projectPath = join(parentPath, "project");
      const displacedPath = join(parentPath, "displaced-project");
      await cp(join(fixtureRoot, "healthy"), projectPath, { recursive: true, force: true });
      const server = await start(projectPath);

      await expect(rename(projectPath, displacedPath)).rejects.toMatchObject({
        code: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u)
      });
      expect((await httpRequest(server, "/api/state")).status).toBe(200);
    }
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when the canonical project directory entry is replaced",
    async () => {
      const parentPath = await mkdtemp(join(tmpdir(), "visp-cockpit-root-replace-"));
      temporaryDirectories.add(parentPath);
      const projectPath = join(parentPath, "project");
      const displacedPath = join(parentPath, "displaced-project");
      await cp(join(fixtureRoot, "healthy"), projectPath, { recursive: true, force: true });
      const server = await start(projectPath);
      expect((await httpRequest(server, "/api/state")).status).toBe(200);

      await rename(projectPath, displacedPath);
      await cp(join(fixtureRoot, "corrupt"), projectPath, { recursive: true, force: true });

      expect((await httpRequest(server, "/api/state")).status).toBe(500);
      expect((await httpRequest(server, "/api/runs?offset=0&limit=1")).status).toBe(500);
    }
  );

  it.skipIf(process.platform === "win32")(
    "rechecks the pinned project root after an asynchronous state read",
    async () => {
      const parentPath = await mkdtemp(join(tmpdir(), "visp-cockpit-root-read-race-"));
      temporaryDirectories.add(parentPath);
      const projectPath = join(parentPath, "project");
      const displacedPath = join(parentPath, "displaced-project");
      await cp(join(fixtureRoot, "healthy"), projectPath, { recursive: true, force: true });
      const baseKit = await loadCockpitKitArtifacts(projectPath, async () => testKitArtifactsModule);
      let signalEntered: () => void = () => undefined;
      const entered = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      let releaseRead: () => void = () => undefined;
      const readBarrier = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const server = await startCockpitServer({
        projectPath,
        port: 0,
        kitArtifacts: Object.freeze({
          ...baseKit,
          reader: Object.freeze({
            ...baseKit.reader,
            projectStatus: async (...args: Parameters<typeof baseKit.reader.projectStatus>) => {
              signalEntered();
              await readBarrier;
              return baseKit.reader.projectStatus(...args);
            }
          })
        })
      });
      openServers.push(server);

      const pendingResponse = httpRequest(server, "/api/state");
      await entered;
      await rename(projectPath, displacedPath);
      await cp(join(fixtureRoot, "corrupt"), projectPath, { recursive: true, force: true });
      releaseRead();

      expect((await pendingResponse).status).toBe(500);
    }
  );

  it("uses a distinct token per server session and rejects another session's token", async () => {
    const projectPath = await copyFixture("healthy");
    const first = await start(projectPath);
    const second = await start(projectPath);

    expect(first.token).toMatch(/\S/u);
    expect(second.token).toMatch(/\S/u);
    expect(first.token).not.toBe(second.token);
    expect((await httpRequest(first, "/api/state", { token: second.token })).status).toBe(401);
    expect((await httpRequest(first, "/api/state")).status).toBe(200);
  });

  it("rejects missing and wrong bearer tokens", async () => {
    const server = await start(await copyFixture("healthy"));
    expect((await httpRequest(server, "/api/state", { token: null })).status).toBe(401);
    expect((await httpRequest(server, "/api/state", { token: "wrong-session-token" })).status).toBe(
      401
    );
  });

  it("accepts a token query for EventSource and still rejects a wrong query token", async () => {
    const server = await start(await copyFixture("healthy"));
    const wrong = await httpRequest(server, "/api/events?token=wrong", { token: null });
    expect(wrong.status).toBe(401);

    const stream = await openSse(server);
    expect(stream.response.statusCode).toBe(200);
    expect(stream.response.headers["content-type"]).toContain("text/event-stream");
    stream.response.destroy();
  });

  it.each([
    "/",
    "/favicon.ico",
    "/api/state",
    "/api/events?token=irrelevant",
    "/api/runs?offset=0&limit=1",
    "/api/runs/run-0001/events?offset=0"
  ])("rejects a foreign Host header on %s", async (pathname) => {
    const server = await start(await copyFixture("healthy"));
    const response = await httpRequest(server, pathname, {
      hostHeader: "attacker.example",
      token: pathname.startsWith("/api/events") ? null : undefined
    });
    expect(response.status).toBe(403);
  });
});

describe("Cockpit live invalidation and read-only boundary (P9-03)", () => {
  it("serves the favicon probe without authentication or repository mutation", async () => {
    const projectPath = await copyFixture("healthy");
    const before = await snapshotTree(projectPath);
    const server = await start(projectPath);

    const response = await httpRequest(server, "/favicon.ico", { token: null });

    expect(response.status).toBe(204);
    expect(response.body).toBe("");
    expect(await snapshotTree(projectPath)).toEqual(before);
  });

  it.each(["healthy", "uninitialized"])(
    "does not mutate the %s repository during server startup",
    async (fixture) => {
      const projectPath = await copyFixture(fixture);
      const before = await snapshotTree(projectPath);
      await start(projectPath);

      expect(await snapshotTree(projectPath)).toEqual(before);
    }
  );

  it("sends path-only invalidation for .visp writes and excludes .visp/cache", async () => {
    const projectPath = await copyFixture("healthy");
    const server = await start(projectPath);
    const stream = await openSse(server);
    const cachePath = join(projectPath, ".visp", "cache", "ignored.json");
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, '{"secret":"CACHE_SENTINEL"}\n', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(stream.messages.join("\n")).not.toContain("cache");

    const watchedPath = join(projectPath, ".visp", "invalidation-target.json");
    await writeFile(watchedPath, '{"secret":"SSE_PAYLOAD_SENTINEL"}\n', "utf8");
    await waitFor(() => stream.messages.some((message) => message.includes("invalidation-target.json")));
    const invalidation = stream.messages.find((message) =>
      message.includes("invalidation-target.json")
    );
    expect(invalidation).toContain(".visp/invalidation-target.json");
    expect(invalidation).not.toContain("SSE_PAYLOAD_SENTINEL");
    stream.response.destroy();
  });

  it("opens no socket during startup and only the test client's loopback sockets during a session", async () => {
    const projectPath = await copyFixture("healthy");
    const connect = vi.spyOn(Socket.prototype, "connect");
    const server = await start(projectPath);

    expect(connect, "Cockpit startup must not make an outbound connection").not.toHaveBeenCalled();

    await httpRequest(server, "/");
    await httpRequest(server, "/api/state");
    await httpRequest(server, "/api/runs?offset=0&limit=1");
    await httpRequest(server, "/api/runs/run-0001/events?offset=0");
    const stream = await openSse(server);
    stream.response.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connect).toHaveBeenCalled();
    for (const call of connect.mock.calls as unknown[][]) {
      const connection = objects(call).find((argument) => "port" in argument) as
        | { host?: string; hostname?: string; port?: number }
        | undefined;
      expect(connection, `unrecognized socket connect call: ${JSON.stringify(call)}`).toBeDefined();
      expect(connection?.host ?? connection?.hostname).toBe("127.0.0.1");
      expect(Number(connection?.port)).toBe(server.port);
    }
  });

  it("does not mutate repository files during startup or through any documented route", async () => {
    const projectPath = await copyFixture("healthy");
    const before = await snapshotTree(projectPath);
    const server = await start(projectPath);

    expect(await snapshotTree(projectPath), "Cockpit startup must be repository read-only").toEqual(
      before
    );

    for (const pathname of [
      "/",
      "/api/state",
      "/api/runs?offset=0&limit=1",
      "/api/runs/run-0001/events?offset=0"
    ]) {
      expect((await httpRequest(server, pathname)).status).toBe(200);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const pathname of ["/api/state", "/api/runs", "/api/runs/run-0001/events"]) {
        expect([404, 405]).toContain((await httpRequest(server, pathname, { method })).status);
      }
    }

    expect(await snapshotTree(projectPath)).toEqual(before);
  });
});

describe("Cockpit static UI security and Phase 9 inventory", () => {
  it("allows only same-origin browser resources under a restrictive CSP", async () => {
    const server = await start(await copyFixture("healthy"));
    const document = await httpRequest(server, "/");
    expect(document.status).toBe(200);
    expect(document.headers["content-type"]).toContain("text/html");
    expect(document.headers["cache-control"]).toBe("no-store");
    expect(document.headers["referrer-policy"]).toBe("no-referrer");
    expect(document.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(document.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(document.headers["x-content-type-options"]).toBe("nosniff");
    expect(document.headers["x-frame-options"]).toBe("DENY");

    const policy = contentSecurityPolicy(document.headers);
    expect(policy.get("default-src")).toEqual(
      expect.arrayContaining([expect.stringMatching(/^'(?:self|none)'$/u)])
    );
    expect(policy.get("default-src")?.every((source) => /^'(?:self|none)'$/u.test(source))).toBe(
      true
    );
    expect(policy.get("connect-src")).toEqual(["'self'"]);
    expect(policy.get("object-src")).toEqual(["'none'"]);
    expect(policy.get("base-uri")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
    expect(policy.get("form-action")).toEqual(["'none'"]);
    expect(policy.get("font-src") ?? ["'none'"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^'(?:self|none)'$/u)])
    );
    expect(
      (policy.get("font-src") ?? ["'none'"]).every((source) =>
        /^'(?:self|none)'$/u.test(source)
      )
    ).toBe(true);

    const policyText = [...policy.values()].flat().join(" ");
    expect(policyText).not.toMatch(/\*|(?:https?|wss?|ftp):|\/\//u);
    expect(policyText).not.toContain("'unsafe-eval'");

    const staticBodies = [document.body];
    for (const resourcePath of staticResourcePaths(document.body)) {
      const resource = await httpRequest(server, resourcePath);
      expect(resource.status, resourcePath).toBe(200);
      staticBodies.push(resource.body);
    }
    const bundledSurface = staticBodies.join("\n");
    expect(bundledSurface).not.toMatch(
      /["'`](?:(?:https?|wss?|ftp):)?\/\/[A-Za-z0-9]/u
    );
    expect(bundledSurface).not.toMatch(/(?:src|href|action)=["']\/\//iu);
    expect(bundledSurface).not.toMatch(/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//iu);
    expect(bundledSurface).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//iu);
    expect(bundledSurface).not.toMatch(
      /fonts\.(?:googleapis|gstatic)|\bcdnjs\b|\b(?:posthog|sentry|analytics)\s*(?:\.|\()|\btelemetry\s*\(/iu
    );
  });

  it("exposes exactly the Phase 9 screens, command palette, and provenance affordances", async () => {
    const server = await start(await copyFixture("healthy"));
    const document = await httpRequest(server, "/");
    const expectedScreens = PHASE_9_SCREEN_IDS.map(
      (screen) => `${screen[0]!.toUpperCase()}${screen.slice(1)}`
    );
    const labels = navigationLabels(document.body);
    const normalizedExpected = expectedScreens.map((screen) => screen.toLowerCase());
    const normalizedLabels = labels.map((label) => label.toLowerCase());
    const screenLabels = normalizedLabels.filter((label) => normalizedExpected.includes(label));
    const unexpectedLabels = normalizedLabels.filter(
      (label) =>
        !normalizedExpected.includes(label) &&
        !label.includes("command palette") &&
        label !== "cockpit" &&
        label !== "visp cockpit"
    );

    expect(screenLabels).toEqual(normalizedExpected);
    expect(new Set(screenLabels).size).toBe(expectedScreens.length);
    expect(unexpectedLabels).toEqual([]);
    expect(document.body).toMatch(/command[\s-]*palette/iu);

    const staticBodies = [document.body];
    for (const resourcePath of staticResourcePaths(document.body)) {
      staticBodies.push((await httpRequest(server, resourcePath)).body);
    }
    expect(staticBodies.join("\n")).toMatch(/source[\s_-]*path|provenance/iu);
  });
});

describe("Cockpit runs and byte-tail APIs (P9-03/P9-05)", () => {
  it("paginates at least 190 runs in deterministic newest-first order", async () => {
    const projectPath = await copyFixture("healthy");
    await writeRunIndex(projectPath, 191);
    const server = await start(projectPath);

    const first = parseJson(await httpRequest(server, "/api/runs?offset=0&limit=64")) as {
      apiVersion: string;
      kind: string;
      sourcePath: string;
      runs: Array<{ id: string }>;
      offset: number;
      limit: number;
      total: number;
      nextOffset: number | null;
    };
    const second = parseJson(await httpRequest(server, `/api/runs?offset=${first.nextOffset}&limit=64`)) as typeof first;
    const third = parseJson(await httpRequest(server, `/api/runs?offset=${second.nextOffset}&limit=64`)) as typeof first;

    expect(first).toMatchObject({
      apiVersion: "1.0",
      kind: "runs-page",
      sourcePath: ".visp/runs/index.json",
      offset: 0,
      limit: 64,
      total: 191,
      nextOffset: 64
    });
    expect(first.runs).toHaveLength(64);
    expect(first.runs[0]?.id).toBe("run-0191");
    expect(second.runs[0]?.id).toBe("run-0127");
    expect(third.runs.at(-1)?.id).toBe("run-0001");
    expect(third.nextOffset).toBeNull();

    await writeRunIndex(projectPath, 10);
    const shrunken = parseJson(
      await httpRequest(server, "/api/runs?offset=128&limit=64")
    ) as typeof first;
    expect(shrunken).toMatchObject({ offset: 128, limit: 64, total: 10, nextOffset: null });
    expect(shrunken.runs).toEqual([]);

    const oversized = parseJson(await httpRequest(server, "/api/runs?offset=0&limit=10000")) as typeof first;
    expect(oversized.limit).toBeLessThan(10_000);
    expect(oversized.runs.length).toBeLessThanOrEqual(oversized.limit);
  });

  it.each([
    "/api/runs?offset=-1&limit=20",
    "/api/runs?offset=nope&limit=20",
    "/api/runs?offset=0&limit=0",
    "/api/runs?offset=0&limit=-1",
    "/api/runs?offset=0&limit=nope",
    "/api/runs/run-0001/events?offset=-1",
    "/api/runs/run-0001/events?offset=nope"
  ])("rejects invalid paging input at %s", async (pathname) => {
    const server = await start(await copyFixture("healthy"));
    expect((await httpRequest(server, pathname)).status).toBe(400);
  });

  it("returns 404 for an unknown run without allowing path traversal", async () => {
    const server = await start(await copyFixture("healthy"));
    expect((await httpRequest(server, "/api/runs/unknown/events?offset=0")).status).toBe(404);
    expect(
      [400, 404].includes(
        (await httpRequest(server, "/api/runs/%2e%2e%2f%2e%2e%2fstatus.json/events?offset=0"))
          .status
      )
    ).toBe(true);
  });

  it.each(["run-directory", "events-file"] as const)(
    "refuses a safe-looking %s symlink that resolves outside .visp/runs",
    async (symlinkCase) => {
      const projectPath = await copyFixture("healthy");
      const runsPath = join(projectPath, ".visp", "runs");
      const externalPath = await mkdtemp(join(tmpdir(), "visp-cockpit-external-run-"));
      temporaryDirectories.add(externalPath);
      const externalEvents = join(externalPath, "events.jsonl");
      const sentinel = "OUTSIDE_PROJECT_SENTINEL";
      await writeFile(
        externalEvents,
        `${JSON.stringify(runEvent("safe-looking-run", "external", sentinel))}\n`,
        "utf8"
      );

      if (symlinkCase === "run-directory") {
        await symlink(externalPath, join(runsPath, "safe-looking-run"), "dir");
      } else {
        const runPath = join(runsPath, "safe-looking-run");
        await mkdir(runPath, { recursive: true });
        await symlink(externalEvents, join(runPath, "events.jsonl"), "file");
      }

      const server = await start(projectPath);
      const response = await httpRequest(
        server,
        "/api/runs/safe-looking-run/events?offset=0"
      );
      expect([400, 403, 404]).toContain(response.status);
      expect(response.body).not.toContain(sentinel);
    }
  );

  it("tails complete JSONL records by bytes, withholding a partial trailing record", async () => {
    const projectPath = await copyFixture("healthy");
    const eventsPath = join(projectPath, ".visp", "runs", "run-byte-tail", "events.jsonl");
    await mkdir(dirname(eventsPath), { recursive: true });
    const firstEvent = runEvent("run-byte-tail", "one", "emoji 🧪");
    const secondEvent = runEvent("run-byte-tail", "two", "plain");
    const thirdEvent = runEvent("run-byte-tail", "three", "complete");
    const first = JSON.stringify(firstEvent) + "\n";
    const second = JSON.stringify(secondEvent) + "\n";
    const third = JSON.stringify(thirdEvent);
    const partial = third.slice(0, Math.floor(third.length / 2));
    await writeFile(eventsPath, first + second + partial, "utf8");
    const server = await start(projectPath);

    const initial = parseJson(
      await httpRequest(server, "/api/runs/run-byte-tail/events?offset=0")
    ) as {
      apiVersion: string;
      kind: string;
      runId: string;
      sourcePath: string;
      events: Array<{ id: string }>;
      offset: number;
      nextOffset: number;
      rotated: boolean;
      generation: string;
    };
    const completeOffset = Buffer.byteLength(first + second);
    expect(initial).toEqual({
      apiVersion: "1.0",
      kind: "run-events-page",
      runId: "run-byte-tail",
      sourcePath: ".visp/runs/run-byte-tail/events.jsonl",
      events: [firstEvent, secondEvent],
      offset: 0,
      nextOffset: completeOffset,
      rotated: false,
      generation: expect.any(String)
    });
    expect(initial.nextOffset).not.toBe((first + second).length);

    await writeFile(eventsPath, first + second + third + "\n", "utf8");
    const appended = parseJson(
      await httpRequest(
        server,
        `/api/runs/run-byte-tail/events?offset=${initial.nextOffset}&generation=${encodeURIComponent(initial.generation)}`
      )
    ) as typeof initial;
    expect(appended).toEqual({
      apiVersion: "1.0",
      kind: "run-events-page",
      runId: "run-byte-tail",
      sourcePath: ".visp/runs/run-byte-tail/events.jsonl",
      events: [thirdEvent],
      offset: completeOffset,
      nextOffset: Buffer.byteLength(first + second + third + "\n"),
      rotated: false,
      generation: expect.any(String)
    });
    expect(appended.generation).not.toBe(initial.generation);
  });

  it("uses the generation cursor to detect an equal-size replacement", async () => {
    const projectPath = await copyFixture("healthy");
    const eventsPath = join(projectPath, ".visp", "runs", "run-rotate", "events.jsonl");
    await mkdir(dirname(eventsPath), { recursive: true });
    const oldEvent = runEvent("run-rotate", "old", "old");
    const original = `${JSON.stringify(oldEvent)}\n`;
    await writeFile(eventsPath, original, "utf8");
    const server = await start(projectPath);
    const first = parseJson(
      await httpRequest(server, "/api/runs/run-rotate/events?offset=0")
    ) as {
      apiVersion: string;
      kind: string;
      runId: string;
      sourcePath: string;
      events: unknown[];
      offset: number;
      nextOffset: number;
      rotated: boolean;
      generation: string;
    };

    const newEvent = runEvent("run-rotate", "new", "new");
    const replacement = `${JSON.stringify(newEvent)}\n`;
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    await writeFile(eventsPath, replacement, "utf8");
    const rotated = parseJson(
      await httpRequest(
        server,
        `/api/runs/run-rotate/events?offset=${first.nextOffset}&generation=${encodeURIComponent(first.generation)}`
      )
    ) as typeof first;
    expect(rotated).toEqual({
      apiVersion: "1.0",
      kind: "run-events-page",
      runId: "run-rotate",
      sourcePath: ".visp/runs/run-rotate/events.jsonl",
      events: [newEvent],
      offset: 0,
      nextOffset: Buffer.byteLength(replacement),
      rotated: true,
      generation: expect.any(String)
    });
    expect(rotated.generation).not.toBe(first.generation);
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["schema-invalid JSON", JSON.stringify({ id: "missing-required-run-event-fields" })]
  ])("reports complete %s explicitly instead of skipping it", async (_case, invalidLine) => {
    const projectPath = await copyFixture("healthy");
    const eventsPath = join(projectPath, ".visp", "runs", "run-corrupt", "events.jsonl");
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(
      eventsPath,
      `${JSON.stringify(runEvent("run-corrupt", "valid", "valid"))}\n${invalidLine}\n`,
      "utf8"
    );
    const server = await start(projectPath);

    const response = await httpRequest(server, "/api/runs/run-corrupt/events?offset=0");
    expect([409, 422]).toContain(response.status);
    expect(response.body).toMatch(/corrupt|unreadable/i);
    expect(response.body).toContain("events.jsonl");
  });
});

describe("Cockpit degraded-state and non-authority conformance (P9-05)", () => {
  it("fails a schema-valid artifact-reader pointer identity mismatch closed", async () => {
    const projectPath = await copyFixture("healthy");
    const pointerPath = join(
      projectPath,
      ".visp",
      "features",
      "001-cockpit",
      "assurance",
      "T001",
      "review-decision.json"
    );
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      pointerPath,
      `${JSON.stringify({ ...pointer, featureId: "999" }, null, 2)}\n`,
      "utf8"
    );
    const response = await httpRequest(await start(projectPath), "/api/state");

    expect(response.status).toBe(200);
    const views = objects(parseJson(response));
    expect(views.find((value) => value.id === "review-decision-pointer")).toMatchObject({
      state: "unavailable"
    });
    expect(views.find((value) => value.id === "review-decision")).toMatchObject({
      state: "unavailable"
    });
  });

  it("fails schema-valid artifact-reader history identity mismatch closed", async () => {
    const projectPath = await copyFixture("healthy");
    await writeSchemaValidMismatchedReviewHistory(projectPath);
    const response = await httpRequest(await start(projectPath), "/api/state");

    expect(response.status).toBe(200);
    const views = objects(parseJson(response));
    expect(views.find((value) => value.id === "review-decision-pointer")).toMatchObject({
      state: "present"
    });
    expect(views.find((value) => value.id === "review-decision")).toMatchObject({
      state: "unavailable"
    });
  });

  it.each([
    [
      "healthy",
      expectedArtifactStates({
        present: [
          "project-status",
          "project-profile",
          "feature-intent",
          "verification",
          "run-index",
          "project-summary",
          "doctor-report",
          "review-decision-pointer"
        ],
        missing: [
          "project-config",
          "policy",
          "workflow",
          "constitution",
          "patterns",
          "specification",
          "plan",
          "task-graph",
          "task-review",
          "assurance-case",
          "review-decision"
        ]
      }),
      false
    ],
    [
      "uninitialized",
      expectedArtifactStates({
        uninitialized: [
          "project-status",
          "project-profile",
          "project-config",
          "policy",
          "workflow",
          "run-index",
          "constitution",
          "patterns",
          "project-summary",
          "doctor-report"
        ],
        unavailable: [
          "feature-intent",
          "specification",
          "plan",
          "task-graph",
          "verification",
          "task-review",
          "assurance-case",
          "review-decision-pointer",
          "review-decision"
        ]
      }),
      false
    ],
    [
      "missing",
      expectedArtifactStates({
        present: ["project-status"],
        missing: [
          "project-profile",
          "project-config",
          "policy",
          "workflow",
          "run-index",
          "constitution",
          "patterns",
          "project-summary",
          "doctor-report",
          "feature-intent",
          "specification",
          "plan",
          "task-graph",
          "verification",
          "task-review",
          "assurance-case",
          "review-decision-pointer"
        ],
        unavailable: ["review-decision"]
      }),
      false
    ],
    [
      "stale",
      expectedArtifactStates({
        stale: ["project-status"],
        missing: [
          "project-profile",
          "project-config",
          "policy",
          "workflow",
          "run-index",
          "constitution",
          "patterns",
          "project-summary",
          "doctor-report"
        ],
        unavailable: [
          "feature-intent",
          "specification",
          "plan",
          "task-graph",
          "verification",
          "task-review",
          "assurance-case",
          "review-decision-pointer",
          "review-decision"
        ]
      }),
      true
    ],
    [
      "corrupt",
      expectedArtifactStates({
        corrupt: ["project-status"],
        missing: [
          "project-profile",
          "project-config",
          "policy",
          "workflow",
          "run-index",
          "constitution",
          "patterns",
          "project-summary",
          "doctor-report"
        ],
        unavailable: [
          "feature-intent",
          "specification",
          "plan",
          "task-graph",
          "verification",
          "task-review",
          "assurance-case",
          "review-decision-pointer",
          "review-decision"
        ]
      }),
      false
    ]
  ] as const)(
    "exposes independent artifact states with fail-closed provenance for the %s fixture",
    async (fixture, expectedStates, injectStaleAfter) => {
      const projectPath = await copyFixture(fixture);
      if (fixture === "stale") {
        const old = new Date("2000-01-01T00:00:00.000Z");
        await utimes(join(projectPath, ".visp", "status.json"), old, old);
      }
      const server = await start(
        projectPath,
        injectStaleAfter
          ? {
              staleAfter: (expectedPath) =>
                expectedPath === ".visp/status.json"
                  ? new Date("2026-08-01T00:00:00.000Z")
                  : undefined
            }
          : {}
      );
      const response = await httpRequest(server, "/api/state");
      expect(response.status).toBe(200);
      const state = parseJson(response);
      const screens = phase9Screens(state);
      expect(await artifactStatesById(projectPath, screens)).toEqual(expectedStates);

      const verdicts = objects(state).flatMap((object) =>
        object.verdict === undefined || object.verdict === null ? [] : [object.verdict]
      );
      expect(verdicts, `${fixture} cannot invent a verdict absent from its artifacts`).toEqual([]);
    }
  );

  it.each(SCREEN_DEGRADED_CASES)(
    "renders missing, stale, and corrupt for $artifactId on every affected screen",
    async ({ artifactId, relativePath, format, screens: affectedScreens }) => {
      for (const state of ["missing", "stale", "corrupt"] as const) {
        const projectPath = await copyFixture("healthy");
        const targetPath = join(projectPath, relativePath);
        if (state === "missing") {
          await rm(targetPath, { force: true });
        } else if (state === "stale") {
          const old = new Date("2000-01-01T00:00:00.000Z");
          await utimes(targetPath, old, old);
        } else {
          await writeFile(targetPath, format === "json" ? "{}\n" : " \n", "utf8");
        }

        const server = await start(
          projectPath,
          state === "stale"
            ? {
                staleAfter: (expectedPath) =>
                  expectedPath === relativePath
                    ? new Date("2026-08-01T00:00:00.000Z")
                    : undefined
              }
            : {}
        );
        const response = await httpRequest(server, "/api/state");
        expect(response.status).toBe(200);
        const payload = parseJson(response);
        const screenMap = phase9Screens(payload);
        const states = await artifactStatesById(projectPath, screenMap);

        expect(states[artifactId], `${artifactId}/${state}`).toBe(state);
        for (const screenId of affectedScreens) {
          const artifact = (
            screenMap.get(screenId)!.artifacts as Array<Record<string, unknown>>
          ).find((entry) => entry.id === artifactId);
          expect(artifact, `${screenId}/${artifactId}/${state}`).toMatchObject({
            id: artifactId,
            state,
            expectedPath: relativePath
          });
          if (state !== "missing") expect(artifact?.sourcePath).toBe(relativePath);
        }

        const verdicts = objects(payload).flatMap((object) =>
          object.verdict === undefined || object.verdict === null ? [] : [object.verdict]
        );
        expect(verdicts, `${artifactId}/${state} cannot invent a verdict`).toEqual([]);
      }
    }
  );

  it("does not apply an implicit stale window to an old but schema-valid artifact", async () => {
    const projectPath = await copyFixture("stale");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(join(projectPath, ".visp", "status.json"), old, old);
    const server = await start(projectPath);
    const screens = phase9Screens(parseJson(await httpRequest(server, "/api/state")));

    expect((await artifactStatesById(projectPath, screens))["project-status"]).toBe("present");
  });

  it("attributes every present artifact to its source path and quotes the artifact command", async () => {
    const server = await start(await copyFixture("healthy"));
    const response = await httpRequest(server, "/api/state");
    expect(response.status).toBe(200);
    const state = parseJson(response);
    const presentArtifacts = objects(state).filter(
      (object) => String(object.state).toLowerCase() === "present"
    );

    expect(presentArtifacts.length).toBeGreaterThan(0);
    for (const artifact of presentArtifacts) {
      expect(artifact.sourcePath ?? artifact.path).toEqual(expect.stringContaining(".visp"));
    }
    for (const expectedPath of [
      ".visp/status.json",
      ".visp/features/001-cockpit/intent.json",
      ".visp/features/001-cockpit/verification.json",
      ".visp/runs/index.json"
    ]) {
      expect(
        presentArtifacts.some((artifact) =>
          String(artifact.sourcePath ?? artifact.path).endsWith(expectedPath)
        ),
        `${expectedPath} must validate as present through the Cockpit's Kit artifact adapter`
      ).toBe(true);
    }
    expect(JSON.stringify(state)).toContain("fixture-next --opaque 91c2");
    expect(JSON.stringify(state)).toContain(".visp/features/001-cockpit/verification.json");
  });

  it("does not synthesize a verdict when no source artifact contains one", async () => {
    const projectPath = await copyFixture("healthy");
    const verificationPath = join(
      projectPath,
      ".visp",
      "features",
      "001-cockpit",
      "verification.json"
    );
    await writeFile(verificationPath, "{}", "utf8");
    const server = await start(projectPath);
    const state = parseJson(await httpRequest(server, "/api/state"));
    const verdicts = objects(state).flatMap((object) =>
      object.verdict === undefined || object.verdict === null ? [] : [object.verdict]
    );

    expect(verdicts).toEqual([]);
    expect(JSON.stringify(state).toLowerCase()).toMatch(/corrupt|unreadable/u);
  });

  it("contains no hardcoded Visp command literal in the Cockpit implementation", async () => {
    const cockpitRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "cockpit");
    const sourceFiles: string[] = [];

    async function collect(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const entryPath = join(path, entry.name);
        if (entry.isDirectory()) await collect(entryPath);
        else if (/\.(?:ts|tsx|js|jsx|html)$/u.test(entry.name)) sourceFiles.push(entryPath);
      }
    }

    await collect(cockpitRoot);
    expect(sourceFiles.length).toBeGreaterThan(0);
    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      expect(source, sourceFile).not.toMatch(
        /["'`]visp(?:-hyper)?[ \t]+[a-z][a-z-]*(?=[ \t"'`])/u
      );
    }
  });
});
