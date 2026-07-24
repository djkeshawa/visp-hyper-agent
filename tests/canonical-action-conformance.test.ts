import { execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli/index.js";
import { handleMessage } from "../src/mcp/mcp-server.js";
import { createToolContext } from "../src/mcp/tool-bridge.js";
import {
  CANONICAL_ACTION_RESOURCE_URI,
  WORKTREE_BRANCH,
  canonicalKitSpec,
  createCanonicalProject,
  createLinkedCanonicalWorktree,
  integrationContractFixture,
  parseActionFrame,
  projectBoundV3Action,
  workflowActionV31Fixture,
  workflowActionV2Fixture
} from "./helpers/canonical-action-fixture.js";
import { createVispShim } from "./helpers/visp-shim.js";

const execFileAsync = promisify(execFile);
const originalPath = process.env.PATH;

type Envelope = {
  frameVersion: "1.0";
  authority: "kit";
  action: Record<string, unknown>;
};

function prependShim(binary: string): void {
  process.env.PATH = `${dirname(binary)}${delimiter}${originalPath ?? ""}`;
}

async function captureCli(projectPath: string, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => {
    lines.push(parts.map(String).join(" "));
  });
  process.exitCode = undefined;
  try {
    await runCli(["node", "visp-hyper", "--project", projectPath, ...args]);
    return lines.join("\n");
  } finally {
    log.mockRestore();
    warn.mockRestore();
    process.exitCode = undefined;
  }
}

async function readMcpEnvelope(projectPath: string): Promise<Envelope> {
  const response = (await handleMessage(createToolContext(projectPath), {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: CANONICAL_ACTION_RESOURCE_URI }
  })) as { result: { contents: Array<{ text: string }> } };
  const resource = JSON.parse(response.result.contents[0]!.text) as {
    availability: string;
    envelope: Envelope;
  };
  expect(resource.availability).toBe("available");
  return resource.envelope;
}

function framedEnvelope(output: string): Envelope {
  return parseActionFrame(output) as Envelope;
}

describe("canonical action cross-surface conformance", () => {
  afterEach(() => {
    process.env.PATH = originalPath;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("rejects duplicate canonical action frames instead of accepting the first", () => {
    const frame = [
      "BEGIN_VISP_HYPER_ACTION_V1",
      JSON.stringify({ frameVersion: "1.0", authority: "kit", action: {} }),
      "END_VISP_HYPER_ACTION_V1"
    ].join("\n");

    expect(() => parseActionFrame(`${frame}\n${frame}`)).toThrow(
      "Expected exactly one compact VISP_HYPER_ACTION_V1 frame."
    );
  });

  it("preserves one complete WorkflowAction 3.1 evidence view across all six surfaces", async () => {
    const projectPath = await createCanonicalProject();
    await execFileAsync("git", ["switch", "-c", WORKTREE_BRANCH], { cwd: projectPath });
    const action = workflowActionV31Fixture();
    const contract = integrationContractFixture({ protocols: ["2.0", "3.0", "3.1"] });
    const shim = await createVispShim(canonicalKitSpec({ action, contract }));
    prependShim(shim.binary);

    const runEnvelope = framedEnvelope(
      await captureCli(projectPath, ["run", "ignored raw goal", "--tool", "codex"])
    );
    const nextEnvelope = framedEnvelope(await captureCli(projectPath, ["next"]));
    const resumeEnvelope = JSON.parse(
      await captureCli(projectPath, ["resume", "--json"])
    ) as Envelope;

    await execFileAsync("git", ["add", "src/feature.ts"], { cwd: projectPath });
    const guardEnvelope = framedEnvelope(await captureCli(projectPath, ["guard", "--staged"]));
    const checkpointEnvelope = framedEnvelope(
      await captureCli(projectPath, ["checkpoint", "--task", "T001"])
    );
    const mcpEnvelope = await readMcpEnvelope(projectPath);

    for (const envelope of [
      runEnvelope,
      nextEnvelope,
      resumeEnvelope,
      guardEnvelope,
      checkpointEnvelope,
      mcpEnvelope
    ]) {
      expect(envelope).toEqual(runEnvelope);
      expect(envelope.action).not.toHaveProperty("wire");
    }
    expect(runEnvelope.action).toMatchObject({
      source: {
        protocolVersion: "3.1",
        selectionMode: "advertised",
        localSchemaHash:
          "sha256:41ffa28fcd4476ea1812ff307df67a7ab7edb5b2cf4d6c11955d34d4aad74d4d"
      },
      sourceCanonicalVersion: { state: "available", value: "1.1" },
      evidence: {
        state: "available",
        value: {
          source: "candidate",
          freshness: "fresh",
          providers: [
            {
              status: "passed",
              results: [{ independence: "pre_approved", outcome: { status: "passed" } }]
            }
          ]
        }
      }
    });
  });

  it.each([
    {
      label: "an ordinary named non-default branch",
      createProject: createCanonicalProject,
      linkedWorktreeWithSpaces: false
    },
    {
      label: "a named linked worktree with spaces",
      createProject: createLinkedCanonicalWorktree,
      linkedWorktreeWithSpaces: true
    }
  ])("preserves one complete v3 public action across all six surfaces in $label", async ({
    createProject,
    linkedWorktreeWithSpaces
  }) => {
    const projectPath = await createProject();
    if (!linkedWorktreeWithSpaces) {
      await execFileAsync("git", ["switch", "-c", WORKTREE_BRANCH], { cwd: projectPath });
    }
    if (linkedWorktreeWithSpaces) {
      expect(projectPath).toContain(" ");
    }
    expect(
      (await execFileAsync("git", ["branch", "--show-current"], { cwd: projectPath })).stdout.trim()
    ).toBe(WORKTREE_BRANCH);

    const action = await projectBoundV3Action(projectPath);
    const shim = await createVispShim(canonicalKitSpec({ action }));
    prependShim(shim.binary);

    const runEnvelope = framedEnvelope(
      await captureCli(projectPath, ["run", "ignored raw goal", "--tool", "codex"])
    );
    const nextEnvelope = framedEnvelope(await captureCli(projectPath, ["next"]));
    const resumeEnvelope = JSON.parse(
      await captureCli(projectPath, ["resume", "--json"])
    ) as Envelope;

    await execFileAsync("git", ["add", "src/feature.ts"], { cwd: projectPath });
    const guardEnvelope = framedEnvelope(await captureCli(projectPath, ["guard", "--staged"]));
    const checkpointOutput = await captureCli(projectPath, ["checkpoint", "--task", "T001"]);
    expect(checkpointOutput).toContain("END_VISP_CHECKPOINT_RESULT\n\nBEGIN_VISP_HYPER_ACTION_V1");
    const checkpointEnvelope = framedEnvelope(checkpointOutput);
    const mcpEnvelope = await readMcpEnvelope(projectPath);

    for (const envelope of [
      runEnvelope,
      nextEnvelope,
      resumeEnvelope,
      guardEnvelope,
      checkpointEnvelope,
      mcpEnvelope
    ]) {
      expect(envelope).toEqual(runEnvelope);
      expect(Object.keys(envelope)).toEqual(["frameVersion", "authority", "action"]);
      expect(envelope.action).not.toHaveProperty("wire");
    }
    expect(runEnvelope.action).toMatchObject({
      source: { protocolVersion: "3.0", selectionMode: "advertised" },
      scope: { writablePaths: ["src/feature.ts", "src/path with spaces.ts"] },
      nextCommand: 'visp gate implement --task "T001 exact" && printf opaque'
    });
  });

  it.each([
    {
      label: "advertised v2",
      contract: integrationContractFixture({ protocols: ["2.0"] }),
      selectionMode: "advertised"
    },
    {
      label: "selector-less legacy v2",
      contract: integrationContractFixture({ protocols: null }),
      selectionMode: "legacy_v2"
    }
  ])("normalizes $label identically across every surface it can validly enter", async ({
    contract,
    selectionMode
  }) => {
    const projectPath = await createCanonicalProject();
    const action = workflowActionV2Fixture({
      requiredReads: [{
        role: "context-pack",
        path: ".visp\\features\\001-pipeline\\context\\T001.context.json",
        sha256: "a".repeat(64)
      }],
      writablePaths: ["src\\feature.ts", "src\\path with spaces.ts"],
      forbiddenPaths: ["secrets\\token.txt"]
    });
    const shim = await createVispShim(canonicalKitSpec({ action, contract }));
    prependShim(shim.binary);

    const runOutput = await captureCli(projectPath, ["run", "v2 must not authorize a session"]);
    const runEnvelope = framedEnvelope(runOutput);
    expect(runOutput).toContain("reason_code: strict_session_adoption_unavailable");
    const nextEnvelope = framedEnvelope(await captureCli(projectPath, ["next"]));
    const resumeEnvelope = JSON.parse(
      await captureCli(projectPath, ["resume", "--json"])
    ) as Envelope;
    await execFileAsync("git", ["add", "src/feature.ts"], { cwd: projectPath });
    const guardOutput = await captureCli(projectPath, ["guard", "--staged"]);
    expect(guardOutput).toContain("END_VISP_GUARD_RESULT\n\nBEGIN_VISP_HYPER_ACTION_V1");
    const guardEnvelope = framedEnvelope(guardOutput);
    const checkpointEnvelope = framedEnvelope(
      await captureCli(projectPath, ["checkpoint", "--task", "T001"])
    );
    const mcpEnvelope = await readMcpEnvelope(projectPath);

    for (const envelope of [runEnvelope, resumeEnvelope, guardEnvelope, checkpointEnvelope, mcpEnvelope]) {
      expect(envelope.action).toEqual(nextEnvelope.action);
    }
    expect(nextEnvelope.action).toMatchObject({
      source: { protocolVersion: "2.0", selectionMode },
      sourceCanonicalVersion: { state: "unavailable", reasonCode: "not_in_protocol" },
      actionId: { state: "unavailable", reasonCode: "not_in_protocol" },
      scope: {
        writablePaths: ["src/feature.ts", "src/path with spaces.ts"],
        forbiddenPaths: ["secrets/token.txt"]
      }
    });
    expect(nextEnvelope.action.requiredReads).toEqual([
      expect.objectContaining({
        role: "context_pack",
        path: ".visp/features/001-pipeline/context/T001.context.json"
      })
    ]);
    expect(nextEnvelope.action).not.toHaveProperty("wire");
  });
});
