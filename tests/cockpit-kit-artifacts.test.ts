import { describe, expect, it, vi } from "vitest";

import {
  COCKPIT_KIT_ARTIFACTS_MODULE_ID,
  CockpitKitArtifactsError,
  loadCockpitKitArtifacts
} from "../src/cockpit/kit-artifacts.js";

const REQUIRED_READER_METHODS = [
  "projectProfile",
  "projectConfig",
  "projectStatus",
  "policy",
  "workflowManifest",
  "featureIntent",
  "specification",
  "plan",
  "taskGraph",
  "verification",
  "taskReview",
  "assuranceCase",
  "currentReviewDecision",
  "reviewDecision",
  "runIndex",
  "constitution",
  "patterns",
  "projectSummary",
  "doctorReport"
] as const;

type RequiredReaderMethod = (typeof REQUIRED_READER_METHODS)[number];

function completeReader(): Record<RequiredReaderMethod, ReturnType<typeof vi.fn>> {
  return Object.fromEntries(REQUIRED_READER_METHODS.map((method) => [method, vi.fn()])) as Record<
    RequiredReaderMethod,
    ReturnType<typeof vi.fn>
  >;
}

function compatibleModule(
  reader = completeReader(),
  parse: (candidate: unknown) => unknown = (candidate) => candidate
) {
  return {
    createArtifactReader: vi.fn(() => reader),
    artifactSchemas: { runEvent: { parse: vi.fn(parse) } }
  };
}

describe("Cockpit Kit artifact module loading", () => {
  it("loads only the injected public artifacts module and creates its reader for the project", async () => {
    const reader = completeReader();
    const kitModule = compatibleModule(reader);
    const loadModule = vi.fn(async () => kitModule);

    expect(loadModule).not.toHaveBeenCalled();

    const loaded = await loadCockpitKitArtifacts("/workspace/example", loadModule);

    expect(COCKPIT_KIT_ARTIFACTS_MODULE_ID).toBe("visp-kit/artifacts");
    expect(loadModule).toHaveBeenCalledExactlyOnceWith("visp-kit/artifacts");
    expect(kitModule.createArtifactReader).toHaveBeenCalledExactlyOnceWith("/workspace/example");
    expect(loaded.reader).toBe(reader);
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it("uses Kit's run-event parser as the authority and returns its exact output", async () => {
    const candidate = Object.freeze({ locallyUnknown: "input" });
    const parsed = Object.freeze({ runId: "RUN-KIT", normalizedByKit: true });
    const kitModule = compatibleModule(completeReader(), () => parsed);
    const loaded = await loadCockpitKitArtifacts("/workspace/example", async () => kitModule);

    expect(loaded.validateRunEvent(candidate)).toBe(parsed);
    expect(kitModule.artifactSchemas.runEvent.parse).toHaveBeenCalledExactlyOnceWith(candidate);
  });

  it("classifies an injected loader failure as module_unavailable without trying a fallback", async () => {
    const loadFailure = new Error("package export not found");
    const loadModule = vi.fn(async () => {
      throw loadFailure;
    });

    const loading = loadCockpitKitArtifacts("/workspace/example", loadModule);

    await expect(loading).rejects.toMatchObject({
      name: "CockpitKitArtifactsError",
      code: "module_unavailable",
      cause: loadFailure
    });
    expect(loadModule).toHaveBeenCalledExactlyOnceWith("visp-kit/artifacts");
  });

  it.each([
    ["a non-object module", undefined],
    ["a missing createArtifactReader factory", { artifactSchemas: { runEvent: { parse: vi.fn() } } }],
    [
      "a non-callable createArtifactReader factory",
      { createArtifactReader: true, artifactSchemas: { runEvent: { parse: vi.fn() } } }
    ],
    ["missing artifact schemas", { createArtifactReader: vi.fn() }],
    ["a missing run-event schema", { createArtifactReader: vi.fn(), artifactSchemas: {} }],
    [
      "a missing run-event parser",
      { createArtifactReader: vi.fn(), artifactSchemas: { runEvent: {} } }
    ]
  ])("classifies %s as an incompatible module", async (_label, kitModule) => {
    await expect(
      loadCockpitKitArtifacts("/workspace/example", async () => kitModule)
    ).rejects.toMatchObject({
      name: "CockpitKitArtifactsError",
      code: "incompatible_module"
    });
  });

  it.each(REQUIRED_READER_METHODS)(
    "rejects a reader missing required %s method",
    async (missingMethod) => {
      const incompleteReader: Record<string, unknown> = { ...completeReader() };
      Reflect.deleteProperty(incompleteReader, missingMethod);
      const kitModule = compatibleModule(incompleteReader as ReturnType<typeof completeReader>);

      await expect(
        loadCockpitKitArtifacts("/workspace/example", async () => kitModule)
      ).rejects.toMatchObject({
        name: "CockpitKitArtifactsError",
        code: "incompatible_module"
      });
    }
  );

  it("classifies an artifact-reader factory failure as an incompatible module", async () => {
    const factoryFailure = new Error("reader construction failed");
    const kitModule = compatibleModule();
    kitModule.createArtifactReader.mockImplementation(() => {
      throw factoryFailure;
    });

    const loading = loadCockpitKitArtifacts("/workspace/example", async () => kitModule);

    await expect(loading).rejects.toMatchObject({
      name: "CockpitKitArtifactsError",
      code: "incompatible_module",
      cause: factoryFailure
    });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["an object without runId", { type: "run.started" }],
    ["an empty runId", { runId: "" }],
    ["a non-string runId", { runId: 42 }]
  ])("rejects %s returned by Kit's run-event parser", async (_label, parserOutput) => {
    const kitModule = compatibleModule(completeReader(), () => parserOutput);
    const loaded = await loadCockpitKitArtifacts("/workspace/example", async () => kitModule);

    expect(() => loaded.validateRunEvent({ runId: "input-was-valid" })).toThrow(
      new TypeError("Kit returned a run event without its run ID.")
    );
    expect(kitModule.artifactSchemas.runEvent.parse).toHaveBeenCalledOnce();
  });

  it("exposes the classified error type for callers", () => {
    const error = new CockpitKitArtifactsError("incompatible_module", "incompatible");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CockpitKitArtifactsError");
    expect(error.code).toBe("incompatible_module");
  });
});
