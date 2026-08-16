// A3, second half: a missing provider must READ as missing.
//
// The dangerous part of the unregistered `visp-intel` server was never the
// missing rows — it was that the missing rows are shaped exactly like a real
// negative answer. The scout with no provider gets no receipt, the collector
// drops every unreceipted row, and the coordinator reads `accepted` with an
// empty path: the same bytes it would read if intel had looked carefully and
// found nothing. Measurement rounds concluding "intel contributed nothing"
// cannot distinguish the two.
//
// These tests pin the distinction. Wherever the coordinator or the user can
// see scout state, an absent provider is named there.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerIntelMcpServer } from "../../../src/install/intel-mcp-registration.js";
import { putNodeExecutableOnPath } from "../../helpers/fake-executable.js";
import { handleMessage } from "../../../src/mcp/mcp-server.js";
import { createToolContext } from "../../../src/mcp/tool-bridge.js";
import { readScoutFindings, renderScoutState } from "../../../src/scout/scout-findings.js";

const SCOUT_FINDINGS_URI = "visp-hyper://current/scout-findings";
const repository = "urn:visp-intel:repository-instance:1.0:sha256:" + "b".repeat(64);
const originalPath = process.env.PATH;

let project: string;

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "vh-scout-provider-"));
});

afterEach(() => {
  process.env.PATH = originalPath;
});

/**
 * A scout run that looked and honestly found nothing: well-formed, in budget,
 * unresolved with a populated question. This is the payload whose meaning the
 * provider line disambiguates.
 */
function emptyButHonestPayload(): unknown {
  return {
    schemaVersion: "1.0",
    taskId: "T001",
    snapshotId: "snap-1",
    repositoryInstanceId: "repo-1",
    status: "unresolved",
    entrypoints: [],
    path: [],
    affectedTests: [],
    unresolved: [
      { question: "Which handler owns retries?", attemptedActions: ["search"], unknownId: null }
    ],
    receiptIds: [],
    budget: { actions: 1, maxActions: 12 }
  };
}

async function writeFindings(payload: unknown): Promise<void> {
  const dir = join(project, ".visp", "hyper", "current");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "scout-findings.json"), JSON.stringify(payload), "utf8");
}

async function registerProvider(): Promise<void> {
  await putNodeExecutableOnPath(
    join(project, "bin"),
    "visp-intel",
    "process.stdout.write('0.1.0\\n');"
  );

  const store = join(project, ".visp-intel", "intel.sqlite");
  await mkdir(join(project, ".visp-intel"), { recursive: true });
  await writeFile(store, "", "utf8");
  const result = await registerIntelMcpServer(project, { store, repository });
  expect(result.outcome).toBe("registered");
}

describe("scout state names an absent intel provider", () => {
  it("marks the provider missing on a project with no .mcp.json", async () => {
    await writeFindings(emptyButHonestPayload());

    const report = await readScoutFindings(project);

    expect(report.state).toBe("accepted");
    expect(report.provider?.registered).toBe(false);
    expect(report.provider?.reason).toMatch(/mcp\.json/i);
  });

  it("renders a loud block, not just an empty result, when nothing provides the tools", async () => {
    await writeFindings(emptyButHonestPayload());

    const rendered = renderScoutState(await readScoutFindings(project));

    expect(rendered).toContain("intel_provider: MISSING");
    expect(rendered).toContain("intel_provider_absent:");
    // The whole point: say out loud that empty is not a finding here.
    expect(rendered).toMatch(/not evidence/i);
    expect(rendered).toContain("mcp__visp-intel__");
  });

  it("says nothing loud once a provider is registered", async () => {
    await registerProvider();
    await writeFindings(emptyButHonestPayload());

    const rendered = renderScoutState(await readScoutFindings(project));

    expect(rendered).toContain("intel_provider: registered");
    expect(rendered).not.toContain("intel_provider_absent:");
  });

  it("names the missing provider even when no scout pass was recorded at all", async () => {
    const report = await readScoutFindings(project);

    expect(report.state).toBe("absent");
    expect(report.provider?.registered).toBe(false);
    expect(renderScoutState(report)).toContain("intel_provider: MISSING");
  });

  it("keeps the pure collector free of project state", async () => {
    // `collectScoutFindings` is shape-and-self-consistency only; provider
    // detection is a project fact and belongs to the reader.
    const { collectScoutFindings } = await import("../../../src/scout/scout-findings.js");
    expect(collectScoutFindings(emptyButHonestPayload()).provider).toBeUndefined();
  });
});

describe("the MCP resource the coordinator reads carries the same fact", () => {
  it("includes the provider state in visp-hyper://current/scout-findings", async () => {
    await writeFindings(emptyButHonestPayload());
    const ctx = createToolContext(project);

    const response = (await handleMessage(ctx, {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: SCOUT_FINDINGS_URI }
    })) as { result?: { contents?: Array<{ text?: string }> } };

    const body = JSON.parse(response.result?.contents?.[0]?.text ?? "{}") as {
      state?: string;
      provider?: { registered?: boolean; reason?: string; declaredTools?: string[] };
    };
    expect(body.state).toBe("accepted");
    expect(body.provider?.registered).toBe(false);
    expect(body.provider?.declaredTools).toContain("mcp__visp-intel__intel_search");
    expect(body.provider?.reason).toBeTruthy();
  });
});

describe("doctor reports a declared tool surface with no provider", () => {
  it("warns when the installed scout declares intel tools nothing registers", async () => {
    const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
    const agents = join(project, ".claude", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, "scout.md"),
      "---\nname: scout\ntools: mcp__visp-intel__intel_search\n---\n",
      "utf8"
    );

    const summary = await runDoctor(project);
    const check = summary.checks.find((candidate) => candidate.id === "intel-mcp");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("mcp__visp-intel__");
    expect(check?.recovery).toBeTruthy();
  });

  it("passes when no installed agent declares the tools", async () => {
    const { runDoctor } = await import("../../../src/cli/commands/doctor.js");

    const summary = await runDoctor(project);
    const check = summary.checks.find((candidate) => candidate.id === "intel-mcp");

    expect(check?.status).toBe("pass");
  });
});
