// A3: the scout declares an MCP tool surface that nothing registered.
//
// `visp setup` installs `.claude/agents/scout.md`, whose front matter names
// five `mcp__visp-intel__*` tools, and no product wrote `.mcp.json`. The scout
// therefore had no provider, produced no receipt, and every row it emitted was
// dropped at the collector — leaving the coordinator with an empty accepted
// list that is indistinguishable from "intel looked and found nothing".
//
// These tests pin the registration half: the server is written, a merge never
// costs another server, and the tool namespace the scout declares stays tied
// to the server name that provides it.

import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  INTEL_MCP_SERVER_NAME,
  INTEL_MCP_TOOL_PREFIX,
  MCP_CONFIG_FILENAME,
  SCOUT_DECLARED_INTEL_TOOLS,
  describeIntelProvider,
  registerIntelMcpServer
} from "../src/install/intel-mcp-registration.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const originalPath = process.env.PATH;

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "visp-intel-mcp-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
});

/** Put a runnable `visp-intel` on PATH so the registration guard can resolve it. */
async function stubVispIntel(): Promise<void> {
  const binDir = join(project, "bin");
  await mkdir(binDir, { recursive: true });
  const shim = join(binDir, "visp-intel");
  await writeFile(shim, "#!/usr/bin/env node\nprocess.stdout.write('0.1.0\\n');\n", "utf8");
  await chmod(shim, 0o755);
  process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
}

async function stubStore(): Promise<string> {
  const store = join(project, ".visp-intel", "intel.sqlite");
  await mkdir(dirname(store), { recursive: true });
  await writeFile(store, "", "utf8");
  return store;
}

async function readMcpConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(project, MCP_CONFIG_FILENAME), "utf8")) as Record<string, unknown>;
}

const repository = "urn:visp-intel:repository-instance:1.0:sha256:" + "a".repeat(64);

describe("the visp-intel MCP server is registered, not assumed", () => {
  it("writes a .mcp.json entry the scout's tool namespace resolves to", async () => {
    await stubVispIntel();
    const store = await stubStore();

    const result = await registerIntelMcpServer(project, { store, repository });

    expect(result.outcome).toBe("registered");
    const config = await readMcpConfig();
    const servers = config.mcpServers as Record<string, { command: string; args: string[] }>;
    expect(Object.keys(servers)).toContain(INTEL_MCP_SERVER_NAME);
    expect(servers[INTEL_MCP_SERVER_NAME]?.args).toEqual([
      "mcp",
      "--store",
      store,
      "--repository",
      repository
    ]);
  });

  it("merges into an existing .mcp.json without costing another server", async () => {
    await stubVispIntel();
    const store = await stubStore();
    await writeFile(
      join(project, MCP_CONFIG_FILENAME),
      JSON.stringify({
        mcpServers: { "visp-hyper": { command: "visp-hyper", args: ["serve", "--mcp"] } },
        someOtherKey: { keep: true }
      }),
      "utf8"
    );

    await registerIntelMcpServer(project, { store, repository });

    const config = await readMcpConfig();
    const servers = config.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["visp-hyper", "visp-intel"]);
    expect(config.someOtherKey).toEqual({ keep: true });
  });

  it("is idempotent: a second registration changes nothing", async () => {
    await stubVispIntel();
    const store = await stubStore();

    await registerIntelMcpServer(project, { store, repository });
    const first = await readFile(join(project, MCP_CONFIG_FILENAME), "utf8");
    const second = await registerIntelMcpServer(project, { store, repository });

    expect(second.outcome).toBe("unchanged");
    expect(await readFile(join(project, MCP_CONFIG_FILENAME), "utf8")).toBe(first);
  });

  it("re-points an entry whose scope drifted, and only then", async () => {
    await stubVispIntel();
    const store = await stubStore();
    await registerIntelMcpServer(project, { store, repository });

    const moved = join(project, ".visp-intel", "other.sqlite");
    await writeFile(moved, "", "utf8");
    const result = await registerIntelMcpServer(project, { store: moved, repository });

    expect(result.outcome).toBe("updated");
    const servers = (await readMcpConfig()).mcpServers as Record<string, { args: string[] }>;
    expect(servers[INTEL_MCP_SERVER_NAME]?.args).toContain(moved);
  });

  it("refuses to clobber a .mcp.json it cannot parse", async () => {
    await stubVispIntel();
    const store = await stubStore();
    await writeFile(join(project, MCP_CONFIG_FILENAME), "{ not json", "utf8");

    const result = await registerIntelMcpServer(project, { store, repository });

    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toMatch(/could not be parsed/i);
    expect(await readFile(join(project, MCP_CONFIG_FILENAME), "utf8")).toBe("{ not json");
  });

  it("refuses with a named reason when the store does not exist", async () => {
    await stubVispIntel();

    const result = await registerIntelMcpServer(project, {
      store: join(project, "missing.sqlite"),
      repository
    });

    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toMatch(/store/i);
  });

  it("accepts a binary that runs but exits non-zero on --version", async () => {
    // The real `visp-intel --version` prints its version and exits 2 (a
    // commander quirk). The guard asks whether the host can SPAWN the binary,
    // not whether it liked the probe — treating a non-zero exit as "not
    // installed" refused every real installation.
    const binDir = join(project, "bin");
    await mkdir(binDir, { recursive: true });
    const shim = join(binDir, "visp-intel");
    await writeFile(
      shim,
      "#!/usr/bin/env node\nprocess.stdout.write('0.1.0\\n');\nprocess.exit(2);\n",
      "utf8"
    );
    await chmod(shim, 0o755);
    process.env.PATH = `${binDir}${delimiter}${process.env.PATH}`;
    const store = await stubStore();

    const result = await registerIntelMcpServer(project, { store, repository });

    expect(result.outcome).toBe("registered");
  });

  it("refuses with a named reason when the visp-intel binary cannot run", async () => {
    const store = await stubStore();
    process.env.PATH = join(project, "empty-bin");

    const result = await registerIntelMcpServer(project, { store, repository });

    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toMatch(/visp-intel/i);
  });
});

describe("absence of a provider is a stated fact, not an empty result", () => {
  it("reports unregistered, with a reason, in a project that has no .mcp.json", async () => {
    const status = await describeIntelProvider(project);

    expect(status.registered).toBe(false);
    expect(status.reason).toMatch(/no \.mcp\.json/i);
    expect(status.declaredTools).toEqual([...SCOUT_DECLARED_INTEL_TOOLS]);
  });

  it("reports unregistered when .mcp.json exists but names other servers only", async () => {
    await writeFile(
      join(project, MCP_CONFIG_FILENAME),
      JSON.stringify({ mcpServers: { "visp-hyper": { command: "visp-hyper" } } }),
      "utf8"
    );

    const status = await describeIntelProvider(project);

    expect(status.registered).toBe(false);
    expect(status.reason).toContain(INTEL_MCP_SERVER_NAME);
  });

  it("reports registered once the server is there", async () => {
    await stubVispIntel();
    const store = await stubStore();
    await registerIntelMcpServer(project, { store, repository });

    const status = await describeIntelProvider(project);

    expect(status.registered).toBe(true);
    expect(status.reason).toBe("");
  });
});

describe("the declared tool namespace stays tied to the server that provides it", () => {
  it("matches every mcp__ tool in the installed scout template", async () => {
    const template = await readFile(
      join(repoRoot, "templates", "claude-code", "agents", "scout.md"),
      "utf8"
    );
    const declared = [...template.matchAll(/mcp__[a-z0-9_-]+__[a-z0-9_]+/gu)].map((match) => match[0]);

    expect(declared.length).toBeGreaterThan(0);
    // Every tool the installed subagent asks for must come from the server the
    // installer actually registers, or the lane silently has no provider again.
    for (const tool of declared) {
      expect(tool.startsWith(INTEL_MCP_TOOL_PREFIX)).toBe(true);
      expect(SCOUT_DECLARED_INTEL_TOOLS).toContain(tool);
    }
    expect([...new Set(declared)].sort()).toEqual([...SCOUT_DECLARED_INTEL_TOOLS].sort());
  });
});
