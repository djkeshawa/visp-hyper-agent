// The advisory routing cohort: which project preset a task's file scope implies,
// and which model id a host defaults to per tier.
//
// Every function here is a lookup table, and a lookup table is exactly the shape
// that fails silently: swap two arms and nothing throws, nothing fails to
// typecheck, and every caller keeps working while routing a Python change under
// the Rust cohort. The mapping is asserted arm by arm for that reason.

import { describe, expect, it } from "vitest";

import {
  defaultModelId,
  inferProjectPreset,
  routingCohortForTask,
  routingTaskFromAction
} from "../../../src/routing/routing-context.js";
import {
  normalizeWorkflowAction,
  type NormalizedWorkflowAction
} from "../../../src/kit/workflow-action-adapter.js";
import {
  TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES,
  workflowActionV3StrictSchema,
  type WorkflowActionProtocolSelection
} from "../../../src/kit/workflow-action-protocol.js";
import {
  tasklessWorkflowActionV3Fixture,
  workflowActionV3Fixture
} from "../../helpers/canonical-action-fixture.js";

function selection(): WorkflowActionProtocolSelection {
  const localSchemaHash = TRUSTED_WORKFLOW_ACTION_SCHEMA_HASHES["3.0"];
  return {
    protocolVersion: "3.0",
    mode: "advertised",
    localSchemaHash,
    schemaHashVerification: { state: "advertised_verified", advertisedHash: localSchemaHash }
  } as WorkflowActionProtocolSelection;
}

function normalized(overrides: Record<string, unknown> = {}): NormalizedWorkflowAction {
  const wire = workflowActionV3StrictSchema.parse(workflowActionV3Fixture(overrides));
  const result = normalizeWorkflowAction(wire, selection());
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe("inferProjectPreset", () => {
  // One case per switch arm. The extensions inside an arm are listed together
  // because a reader checking the table wants to see the whole arm at once, and
  // because dropping one of them is the realistic regression.
  const arms: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["typescript", [".ts", ".tsx"]],
    ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
    ["python", [".py"]],
    ["rust", [".rs"]],
    ["go", [".go"]],
    ["jvm", [".java", ".kt"]],
    ["dotnet", [".cs"]],
    ["documentation", [".md", ".mdx"]],
    ["configuration", [".json", ".yaml", ".yml", ".toml"]]
  ];

  for (const [preset, extensions] of arms) {
    it(`maps ${extensions.join(", ")} to the ${preset} preset`, () => {
      for (const extension of extensions) {
        expect(inferProjectPreset([`src/module${extension}`])).toBe(preset);
      }
    });
  }

  it("is generic when no path carries a recognised extension", () => {
    expect(inferProjectPreset([])).toBe("generic");
    expect(inferProjectPreset(["Makefile", "src/bin/tool", "docs/notes.unknownext"])).toBe(
      "generic"
    );
  });

  it("is the single preset when every recognised path agrees", () => {
    // Unrecognised paths must not tip a single-language project into `mixed`:
    // they contribute no preset at all rather than a "generic" one.
    expect(inferProjectPreset(["src/a.ts", "src/b.tsx", "Makefile"])).toBe("typescript");
  });

  it("is mixed when recognised paths disagree", () => {
    expect(inferProjectPreset(["src/a.ts", "scripts/b.py"])).toBe("mixed");
  });

  it("reads the extension of the file name, not of a directory along the path", () => {
    // The pattern anchors on the last segment. A directory called `v1.2` must
    // not be read as a `.2` extension, and must not make the project `mixed`.
    expect(inferProjectPreset(["schemas/v1.2/model.py"])).toBe("python");
  });

  it("ignores case, so a Windows-cased path lands in the same preset", () => {
    expect(inferProjectPreset(["SRC/Module.TS"])).toBe("typescript");
  });
});

describe("defaultModelId", () => {
  it("names Claude Code's tier models", () => {
    expect(defaultModelId("claude-code", "scout")).toBe("sonnet");
    expect(defaultModelId("claude-code", "implementer")).toBe("opus");
    expect(defaultModelId("claude-code", "coordinator")).toBe("inherit");
  });

  it("returns the tier itself for a Claude Code tier it has no model for", () => {
    expect(defaultModelId("claude-code", "reviewer")).toBe("reviewer");
  });

  it("returns the tier itself for every other host", () => {
    // Hyper recommends; the host owns model execution. A host Hyper has no
    // table for gets the tier name back, never Claude Code's model ids.
    expect(defaultModelId("codex", "scout")).toBe("scout");
    expect(defaultModelId("copilot", "implementer")).toBe("implementer");
  });
});

describe("routingCohortForTask", () => {
  it("prefers an explicitly passed assurance profile over the task's own", () => {
    const cohort = routingCohortForTask({
      host: "codex",
      task: { assuranceProfile: "routine", allowedFiles: ["src/a.ts"] },
      assuranceProfile: "critical"
    });
    expect(cohort.assuranceProfile).toBe("critical");
  });

  it("distinguishes an explicit null from an absent assurance profile", () => {
    // `undefined` means "not stated, fall back to the task"; `null` means "the
    // caller states there is none". Collapsing them with `??` would silently
    // re-read the task's profile when the caller had ruled it out.
    const stated = routingCohortForTask({
      host: "codex",
      task: { assuranceProfile: "critical", allowedFiles: [] },
      assuranceProfile: null
    });
    const absent = routingCohortForTask({
      host: "codex",
      task: { assuranceProfile: "critical", allowedFiles: [] }
    });
    expect(stated.assuranceProfile).toBeNull();
    expect(absent.assuranceProfile).toBe("critical");
  });

  it("infers the preset from the allowed and expected files together", () => {
    const cohort = routingCohortForTask({
      host: "claude-code",
      task: { allowedFiles: ["src/a.ts"], expectedFiles: ["scripts/b.py"] }
    });
    expect(cohort.projectPreset).toBe("mixed");
  });

  it("falls back to the host's cheap-tier model and a null model version", () => {
    const cohort = routingCohortForTask({ host: "claude-code", task: { allowedFiles: [] } });
    expect(cohort.modelId).toBe("sonnet");
    expect(cohort.modelVersion).toBeNull();
    expect(cohort.host).toBe("claude-code");
    expect(cohort.projectPreset).toBe("generic");
  });

  it("keeps a caller-supplied model id and version", () => {
    const cohort = routingCohortForTask({
      host: "claude-code",
      task: { allowedFiles: [] },
      modelId: "haiku",
      modelVersion: "2026-05-01"
    });
    expect(cohort.modelId).toBe("haiku");
    expect(cohort.modelVersion).toBe("2026-05-01");
  });
});

describe("routingTaskFromAction", () => {
  it("is null for an action with no active task", () => {
    const wire = workflowActionV3StrictSchema.parse(tasklessWorkflowActionV3Fixture());
    const result = normalizeWorkflowAction(wire, selection());
    if (!result.ok) throw new Error(result.reason);
    expect(routingTaskFromAction(result.value)).toBeNull();
  });

  it("carries expectedFiles only when Kit declared them available", () => {
    const withExpected = routingTaskFromAction(
      normalized({
        scope: {
          writablePaths: ["src/feature.ts"],
          expectedPaths: { state: "available", value: ["src/feature.test.ts"] },
          forbiddenPaths: ["secrets"],
          operationLimits: { state: "unavailable", reasonCode: "not_in_source_artifact" }
        }
      })
    );
    const withoutExpected = routingTaskFromAction(normalized());

    expect(withExpected?.expectedFiles).toEqual(["src/feature.test.ts"]);
    // Absent, not empty: an empty list is a claim that Kit expects no files,
    // which is a different statement from Kit not having said.
    expect(withoutExpected).not.toHaveProperty("expectedFiles");
  });

  it("reads an undeclared taskClass, risk or assurance profile as null, never as a value", () => {
    const descriptor = routingTaskFromAction(normalized());
    expect(descriptor?.id).toBe("T001");
    expect(descriptor?.taskClass).toBeNull();
    expect(descriptor?.riskFactors).toBeNull();
    expect(descriptor?.assuranceProfile).toBeNull();
    // The fixture declares risk level and nothing else, so it must survive.
    expect(descriptor?.riskLevel).toBe("high");
    expect(descriptor?.allowedFiles).toEqual(["src/feature.ts", "src/path with spaces.ts"]);
  });
});
