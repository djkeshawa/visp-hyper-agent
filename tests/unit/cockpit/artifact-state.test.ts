import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readCockpitState,
  type CockpitKitArtifactReader,
  type CockpitKitReadState,
  type CockpitStaleAfterResolver
} from "../../../src/cockpit/artifact-state.js";
import {
  COCKPIT_MEMORY_ARTIFACT_PATHS,
  cockpitArtifactPath,
  type CockpitArtifactPath,
  type CockpitArtifactView,
  type CockpitScreenId,
  type CockpitStateV1
} from "../../../src/cockpit/contracts.js";

const FEATURE_KEY = "007-canonical-feature";
const FEATURE_ID = "007";
const FEATURE_SLUG = "canonical-feature";
const TASK_ID = "T-042";
const DECISION_HASH = `sha256:${"a".repeat(64)}`;
const DECISION_DIGEST = "a".repeat(64);
const DECIDED_AT = "2026-08-01T10:00:00.000Z";

const PATHS = Object.freeze({
  status: ".visp/status.json",
  profile: ".visp/project.json",
  config: ".visp/config.json",
  policy: ".visp/policy.json",
  workflow: ".visp/workflow.json",
  intent: `.visp/features/${FEATURE_KEY}/intent.json`,
  specification: `.visp/features/${FEATURE_KEY}/spec.json`,
  plan: `.visp/features/${FEATURE_KEY}/plan.json`,
  taskGraph: `.visp/features/${FEATURE_KEY}/task-graph.json`,
  verification: `.visp/features/${FEATURE_KEY}/verification.json`,
  taskReview: `.visp/features/${FEATURE_KEY}/review/${TASK_ID}.review.json`,
  assuranceCase: `.visp/features/${FEATURE_KEY}/assurance/${TASK_ID}/assurance-case.json`,
  decisionPointer: `.visp/features/${FEATURE_KEY}/assurance/${TASK_ID}/review-decision.json`,
  reviewDecision:
    `.visp/features/${FEATURE_KEY}/assurance/${TASK_ID}/review-decisions/${DECISION_DIGEST}.json`,
  runIndex: ".visp/runs/index.json",
  constitution: ".visp/memory/constitution.md",
  patterns: ".visp/memory/patterns.md",
  projectSummary: ".visp/memory/project-summary.md",
  doctor: ".visp/reports/doctor-report.md"
} as const);

const temporaryDirectories = new Set<string>();
let projectPath: string;

beforeEach(async () => {
  projectPath = await mkdtemp(resolve(tmpdir(), "visp-cockpit-artifact-state-"));
  temporaryDirectories.add(projectPath);
  await mkdir(resolve(projectPath, ".visp"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
  );
  temporaryDirectories.clear();
});

function absolute(relativePath: string): string {
  return resolve(projectPath, relativePath);
}

function present<T>(relativePath: string, value: T): CockpitKitReadState<T> {
  return {
    state: "present",
    path: absolute(relativePath),
    modifiedAt: "2026-08-01T10:00:00.000Z",
    value
  };
}

function missing(relativePath: string): CockpitKitReadState {
  const path = absolute(relativePath);
  return { state: "missing", path, reason: `Artifact is missing at ${path}.` };
}

function stale<T>(relativePath: string, value: T): CockpitKitReadState<T> {
  const path = absolute(relativePath);
  return {
    state: "stale",
    path,
    modifiedAt: "2026-08-01T08:00:00.000Z",
    staleAfter: "2026-08-01T09:00:00.000Z",
    reason: `Artifact at ${path} is older than the required freshness boundary.`,
    value
  };
}

function unreadable(
  relativePath: string,
  issue: "io" | "invalid_json" | "invalid_schema"
): CockpitKitReadState {
  const path = absolute(relativePath);
  return {
    state: "unreadable",
    path,
    issue,
    reason: `${issue} while reading ${path}.`
  };
}

function validDecisionPointer(overrides: Record<string, unknown> = {}) {
  return {
    featureId: FEATURE_ID,
    featureSlug: FEATURE_SLUG,
    taskId: TASK_ID,
    decisionPath: PATHS.reviewDecision,
    decisionHash: DECISION_HASH,
    updatedAt: DECIDED_AT,
    ...overrides
  };
}

function validDecisionHistory(overrides: Record<string, unknown> = {}) {
  return {
    featureId: FEATURE_ID,
    featureSlug: FEATURE_SLUG,
    taskId: TASK_ID,
    reviewerId: "human-reviewer",
    decision: "accept",
    reason: "stored decision",
    decidedAt: DECIDED_AT,
    decisionHash: DECISION_HASH,
    ...overrides
  };
}

function fakeReader(
  overrides: Partial<CockpitKitArtifactReader> = {}
): CockpitKitArtifactReader {
  const reader: CockpitKitArtifactReader = {
    projectProfile: vi.fn(async () => missing(PATHS.profile)),
    projectConfig: vi.fn(async () => missing(PATHS.config)),
    projectStatus: vi.fn(async () => missing(PATHS.status)),
    policy: vi.fn(async () => missing(PATHS.policy)),
    workflowManifest: vi.fn(async () => missing(PATHS.workflow)),
    featureIntent: vi.fn(async (featureKey) =>
      missing(`.visp/features/${featureKey}/intent.json`)
    ),
    specification: vi.fn(async (featureKey) =>
      missing(`.visp/features/${featureKey}/spec.json`)
    ),
    plan: vi.fn(async (featureKey) => missing(`.visp/features/${featureKey}/plan.json`)),
    taskGraph: vi.fn(async (featureKey) =>
      missing(`.visp/features/${featureKey}/task-graph.json`)
    ),
    verification: vi.fn(async (featureKey) =>
      missing(`.visp/features/${featureKey}/verification.json`)
    ),
    taskReview: vi.fn(async (featureKey, taskId) =>
      missing(`.visp/features/${featureKey}/review/${taskId}.review.json`)
    ),
    assuranceCase: vi.fn(async (featureKey, taskId) =>
      missing(`.visp/features/${featureKey}/assurance/${taskId}/assurance-case.json`)
    ),
    currentReviewDecision: vi.fn(async (featureKey, taskId) =>
      missing(`.visp/features/${featureKey}/assurance/${taskId}/review-decision.json`)
    ),
    reviewDecision: vi.fn(async (featureKey, taskId, decisionHash) =>
      missing(
        `.visp/features/${featureKey}/assurance/${taskId}/review-decisions/${decisionHash.slice("sha256:".length)}.json`
      )
    ),
    runIndex: vi.fn(async () => missing(PATHS.runIndex)),
    constitution: vi.fn(async () => missing(PATHS.constitution)),
    patterns: vi.fn(async () => missing(PATHS.patterns)),
    projectSummary: vi.fn(async () => missing(PATHS.projectSummary)),
    doctorReport: vi.fn(async () => missing(PATHS.doctor))
  };
  return Object.freeze({ ...reader, ...overrides });
}

function healthyReader(): CockpitKitArtifactReader {
  return fakeReader({
    projectStatus: vi.fn(async () =>
      present(PATHS.status, {
        initialized: true,
        activeFeatureId: FEATURE_ID,
        activeFeatureSlug: FEATURE_SLUG,
        activeFeaturePath: `.visp/features/${FEATURE_KEY}`,
        activeTaskId: TASK_ID,
        currentState: "verified",
        lastCommand: "verify",
        updatedAt: "2026-08-01T10:00:00.000Z"
      })
    ),
    projectProfile: vi.fn(async () =>
      present(PATHS.profile, {
        name: "Artifact state fixture",
        packageManager: "pnpm",
        buildCommands: ["stored-profile-build"],
        testCommands: ["stored-profile-test"],
        lintCommands: ["stored-profile-lint"],
        typecheckCommands: ["stored-profile-typecheck"]
      })
    ),
    projectConfig: vi.fn(async () =>
      present(PATHS.config, { schemaVersion: "1", projectId: "fixture-project" })
    ),
    policy: vi.fn(async () => present(PATHS.policy, { version: "1", strictnessMode: "strict" })),
    workflowManifest: vi.fn(async () =>
      present(PATHS.workflow, {
        version: "1",
        stages: [
          {
            name: "stored stage",
            command: "stored-workflow-command",
            nextCommand: "stored-workflow-next"
          }
        ]
      })
    ),
    featureIntent: vi.fn(async () =>
      present(PATHS.intent, { id: "007", title: "Canonical feature intent" })
    ),
    specification: vi.fn(async () =>
      present(PATHS.specification, { requirement: "stored specification" })
    ),
    plan: vi.fn(async () => present(PATHS.plan, { approach: "stored plan" })),
    taskGraph: vi.fn(async () =>
      present(PATHS.taskGraph, {
        featureId: "007",
        tasks: [
          {
            id: TASK_ID,
            title: "Stored task",
            validationCommands: ["stored-task-validation"]
          }
        ]
      })
    ),
    verification: vi.fn(async () =>
      present(PATHS.verification, {
        id: "VER-007-T042",
        taskId: TASK_ID,
        success: true,
        scopeValidation: { status: "passed", changedFiles: ["src/cockpit/artifact-state.ts"] },
        nextCommand: "stored-verification-next"
      })
    ),
    taskReview: vi.fn(async () =>
      present(PATHS.taskReview, {
        id: "REV-007-T042",
        taskId: TASK_ID,
        result: "approved",
        nextCommand: "stored-review-next"
      })
    ),
    assuranceCase: vi.fn(async () =>
      present(PATHS.assuranceCase, {
        taskId: TASK_ID,
        assuranceProfile: "behavioral",
        claims: [{ id: "claim-from-artifact" }],
        nextAction: { command: "stored-assurance-next", reason: "stored reason" }
      })
    ),
    currentReviewDecision: vi.fn(async () =>
      present(PATHS.decisionPointer, validDecisionPointer())
    ),
    reviewDecision: vi.fn(async () =>
      present(PATHS.reviewDecision, validDecisionHistory())
    ),
    runIndex: vi.fn(async () =>
      present(PATHS.runIndex, {
        latestRunId: "run-0001",
        runs: [{ id: "run-0001", command: "stored-run-command", result: "passed" }]
      })
    ),
    constitution: vi.fn(async () => present(PATHS.constitution, "# Stored constitution")),
    patterns: vi.fn(async () => present(PATHS.patterns, "# Stored patterns")),
    projectSummary: vi.fn(async () =>
      present(PATHS.projectSummary, "# Stored project summary")
    ),
    doctorReport: vi.fn(async () => present(PATHS.doctor, "# Stored doctor report"))
  });
}

function artifact(
  state: CockpitStateV1,
  screenId: CockpitScreenId,
  artifactId: string
): CockpitArtifactView {
  const match = state.screens[screenId].artifacts.find((entry) => entry.id === artifactId);
  expect(match, `${screenId} must include ${artifactId}`).toBeDefined();
  return match!;
}

describe("Cockpit Kit-state translation", () => {
  it.each([
    ["present", () => present(PATHS.status, { initialized: true }), "present"],
    ["missing", () => missing(PATHS.status), "missing"],
    ["stale", () => stale(PATHS.status, { initialized: true }), "stale"],
    ["invalid JSON", () => unreadable(PATHS.status, "invalid_json"), "corrupt"],
    ["invalid schema", () => unreadable(PATHS.status, "invalid_schema"), "corrupt"],
    ["I/O failure", () => unreadable(PATHS.status, "io"), "unavailable"]
  ] as const)("maps a Kit %s result without collapsing it", async (_case, result, expectedState) => {
    const reader = fakeReader({ projectStatus: vi.fn(async () => result()) });

    const state = await readCockpitState({ projectPath, reader });
    const status = artifact(state, "now", "project-status");

    expect(status.state).toBe(expectedState);
    expect("sourcePath" in status ? status.sourcePath : undefined).toBe(
      expectedState === "present" || expectedState === "stale" || expectedState === "corrupt" ||
        (expectedState === "unavailable" && _case === "I/O failure")
        ? PATHS.status
        : undefined
    );
    expect(JSON.stringify(status)).not.toContain(projectPath);
  });

  it("maps missing artifacts to uninitialized only when the .visp root is absent", async () => {
    await rm(resolve(projectPath, ".visp"), { recursive: true });
    const state = await readCockpitState({ projectPath, reader: fakeReader() });

    expect(artifact(state, "now", "project-status")).toEqual({
      id: "project-status",
      label: "Project status",
      state: "uninitialized",
      reason: "The repository has no .visp artifact root.",
      expectedPath: PATHS.status
    });
    expect(artifact(state, "reference", "project-profile").state).toBe("uninitialized");
  });

  it.each([
    ["throws", () => Promise.reject(new Error("reader exploded"))],
    ["returns null", () => Promise.resolve(null)],
    [
      "returns an unknown state",
      () => Promise.resolve({ state: "healthy", path: absolute(PATHS.status) })
    ],
    [
      "returns a malformed present result",
      () => Promise.resolve({ state: "present", path: absolute(PATHS.status) })
    ]
  ])("fails unavailable when an accessor %s", async (_case, read) => {
    const reader = fakeReader({
      projectStatus: vi.fn(read) as unknown as CockpitKitArtifactReader["projectStatus"]
    });

    const status = artifact(await readCockpitState({ projectPath, reader }), "now", "project-status");

    expect(status).toEqual({
      id: "project-status",
      label: "Project status",
      state: "unavailable",
      reason: expect.stringMatching(/could not read|unsupported artifact state/u),
      expectedPath: PATHS.status
    });
    expect(JSON.stringify(status)).not.toContain("reader exploded");
  });

  it.each([
    ["another in-repository artifact", () => absolute(PATHS.profile)],
    ["an outside artifact", () => resolve(projectPath, "..", "outside-status.json")],
    ["a repository-relative path", () => PATHS.status]
  ])("rejects provenance that names %s", async (_case, actualPath) => {
    const reader = fakeReader({
      projectStatus: vi.fn(async () => ({
        state: "present" as const,
        path: actualPath(),
        modifiedAt: "2026-08-01T10:00:00.000Z",
        value: { initialized: true }
      }))
    });

    const status = artifact(await readCockpitState({ projectPath, reader }), "now", "project-status");

    expect(status).toMatchObject({
      state: "unavailable",
      expectedPath: PATHS.status,
      reason: expect.stringContaining("mismatched provenance")
    });
    expect("sourcePath" in status).toBe(false);
  });
});

describe("Cockpit artifact selection and exact screen mapping", () => {
  it("derives coordinates only from the exact status path and uses canonical intent/task-review paths", async () => {
    const reader = healthyReader();
    const state = await readCockpitState({ projectPath, reader });

    expect(reader.featureIntent).toHaveBeenCalledWith(FEATURE_KEY, undefined);
    expect(reader.taskReview).toHaveBeenCalledWith(FEATURE_KEY, TASK_ID, undefined);
    expect(reader.reviewDecision).toHaveBeenCalledWith(
      FEATURE_KEY,
      TASK_ID,
      DECISION_HASH,
      undefined
    );
    expect(artifact(state, "feature", "feature-intent")).toMatchObject({
      state: "present",
      sourcePath: PATHS.intent
    });
    expect(artifact(state, "review", "task-review")).toMatchObject({
      state: "present",
      sourcePath: PATHS.taskReview
    });
  });

  it("does not infer a feature directory from activeFeatureId or activeFeatureSlug", async () => {
    const reader = fakeReader({
      projectStatus: vi.fn(async () =>
        present(PATHS.status, {
          initialized: true,
          activeFeatureId: "007",
          activeFeatureSlug: "tempting-slug",
          activeFeaturePath: null,
          activeTaskId: TASK_ID
        })
      )
    });

    const state = await readCockpitState({ projectPath, reader });

    expect(reader.featureIntent).not.toHaveBeenCalled();
    expect(reader.taskReview).not.toHaveBeenCalled();
    expect(artifact(state, "feature", "feature-intent")).toMatchObject({
      state: "unavailable",
      expectedPath: PATHS.status
    });
  });

  it.each([
    ".visp/features/007/nested",
    ".visp/features/../escape",
    ".visp/memory/007-canonical-feature",
    "/absolute/features/007-canonical-feature"
  ])("does not use a non-canonical activeFeaturePath %s", async (activeFeaturePath) => {
    const reader = fakeReader({
      projectStatus: vi.fn(async () =>
        present(PATHS.status, {
          activeFeatureId: "007",
          activeFeatureSlug: "canonical-feature",
          activeFeaturePath,
          activeTaskId: TASK_ID
        })
      )
    });

    await readCockpitState({ projectPath, reader });

    expect(reader.featureIntent).not.toHaveBeenCalled();
    expect(reader.taskReview).not.toHaveBeenCalled();
  });

  it("uses a safe activeTaskId only and never selects a task from the task graph", async () => {
    const reader = fakeReader({
      projectStatus: vi.fn(async () =>
        present(PATHS.status, {
          activeFeaturePath: `.visp/features/${FEATURE_KEY}`,
          activeTaskId: "../T-042"
        })
      ),
      taskGraph: vi.fn(async () =>
        present(PATHS.taskGraph, {
          featureId: "007",
          tasks: [{ id: TASK_ID, status: "ready", validationCommands: [] }]
        })
      )
    });

    const state = await readCockpitState({ projectPath, reader });

    expect(reader.taskGraph).toHaveBeenCalledWith(FEATURE_KEY, undefined);
    expect(reader.taskReview).not.toHaveBeenCalled();
    expect(artifact(state, "review", "task-review")).toMatchObject({
      state: "unavailable",
      expectedPath: PATHS.status
    });
  });

  it("fails both review views closed when the pointer cannot bind to active coordinates and history", async () => {
    const mismatches = [
      ["missing active feature ID", {}, { activeFeatureId: undefined }],
      ["missing active feature slug", {}, { activeFeatureSlug: undefined }],
      ["pointer feature ID", { featureId: "008" }, {}],
      ["pointer feature slug", { featureSlug: "other-feature" }, {}],
      ["pointer task ID", { taskId: "T-999" }, {}],
      [
        "pointer decision path",
        {
          decisionPath:
            `.visp/features/${FEATURE_KEY}/assurance/${TASK_ID}/review-decisions/${"b".repeat(64)}.json`
        },
        {}
      ],
      ["pointer decision hash", { decisionHash: "not-a-sha256-hash" }, {}]
    ] as const;
    const reasons = new Set<string>();

    for (const [label, pointerOverrides, statusOverrides] of mismatches) {
      const reader = healthyReader();
      vi.mocked(reader.projectStatus).mockResolvedValue(
        present(PATHS.status, {
          initialized: true,
          activeFeatureId: FEATURE_ID,
          activeFeatureSlug: FEATURE_SLUG,
          activeFeaturePath: `.visp/features/${FEATURE_KEY}`,
          activeTaskId: TASK_ID,
          ...statusOverrides
        })
      );
      vi.mocked(reader.currentReviewDecision).mockResolvedValue(
        present(PATHS.decisionPointer, validDecisionPointer(pointerOverrides))
      );

      const state = await readCockpitState({ projectPath, reader });
      const pointer = artifact(state, "review", "review-decision-pointer");
      const history = artifact(state, "review", "review-decision");

      expect(pointer, label).toMatchObject({ state: "unavailable" });
      expect(history, label).toMatchObject({ state: "unavailable" });
      expect(reader.reviewDecision, label).not.toHaveBeenCalled();
      if (pointer.state !== "unavailable" || history.state !== "unavailable") {
        throw new Error(`${label} did not fail closed.`);
      }
      expect(pointer.reason, label).toBe(history.reason);
      reasons.add(pointer.reason);
    }

    expect(reasons.size).toBe(1);
  });

  it("keeps the literal pointer but fails history closed when their identities do not bind", async () => {
    const mismatches = [
      ["history feature ID", { featureId: "008" }],
      ["history feature slug", { featureSlug: "other-feature" }],
      ["history task ID", { taskId: "T-999" }],
      ["history decision hash", { decisionHash: `sha256:${"b".repeat(64)}` }],
      ["history decided-at timestamp", { decidedAt: "2026-08-01T10:00:01.000Z" }]
    ] as const;
    const reasons = new Set<string>();

    for (const [label, historyOverrides] of mismatches) {
      const reader = healthyReader();
      vi.mocked(reader.reviewDecision).mockResolvedValue(
        present(PATHS.reviewDecision, validDecisionHistory(historyOverrides))
      );

      const state = await readCockpitState({ projectPath, reader });
      const pointer = artifact(state, "review", "review-decision-pointer");
      const history = artifact(state, "review", "review-decision");

      expect(pointer, label).toMatchObject({
        state: "present",
        sourcePath: PATHS.decisionPointer
      });
      expect(history, label).toMatchObject({ state: "unavailable" });
      expect(reader.reviewDecision, label).toHaveBeenCalledWith(
        FEATURE_KEY,
        TASK_ID,
        DECISION_HASH,
        undefined
      );
      if (history.state !== "unavailable") throw new Error(`${label} did not fail closed.`);
      reasons.add(history.reason);
    }

    expect(reasons.size).toBe(1);
  });

  it("places each bounded artifact on the exact screens without an aggregate screen state", async () => {
    const state = await readCockpitState({ projectPath, reader: healthyReader() });
    const expected = {
      now: ["project-status"],
      feature: ["feature-intent", "specification", "plan", "task-graph"],
      scope: ["task-graph", "verification"],
      assurance: ["verification", "assurance-case"],
      review: ["task-review", "review-decision-pointer", "review-decision"],
      runs: ["run-index"],
      memory: ["constitution", "patterns", "project-summary"],
      health: ["doctor-report"],
      reference: ["project-profile", "project-config", "policy", "workflow"]
    } as const;

    for (const [screenId, artifactIds] of Object.entries(expected)) {
      const screen = state.screens[screenId as CockpitScreenId];
      expect(screen.artifacts.map(({ id }) => id), screenId).toEqual(artifactIds);
      expect(Object.keys(screen).sort(), screenId).toEqual(["artifacts", "id", "label"]);
      expect(screen).not.toHaveProperty("state");
      expect(screen).not.toHaveProperty("verdict");
    }
  });

  it("reads exactly the three canonical .visp/memory Markdown artifacts", async () => {
    const reader = healthyReader();
    const state = await readCockpitState({ projectPath, reader });

    expect(reader.constitution).toHaveBeenCalledWith(undefined);
    expect(reader.patterns).toHaveBeenCalledWith(undefined);
    expect(reader.projectSummary).toHaveBeenCalledWith(undefined);
    expect(state.screens.memory.artifacts.map((entry) =>
      "sourcePath" in entry ? entry.sourcePath : entry.expectedPath
    )).toEqual(COCKPIT_MEMORY_ARTIFACT_PATHS);
    expect(JSON.stringify(state.screens.memory)).not.toContain(".visp-memory");
  });
});

describe("Cockpit freshness, quotation, and commands", () => {
  it("supplies no implicit freshness boundary", async () => {
    const reader = healthyReader();

    await readCockpitState({ projectPath, reader });

    expect(reader.projectStatus).toHaveBeenCalledWith(undefined);
    expect(reader.projectProfile).toHaveBeenCalledWith(undefined);
    expect(reader.featureIntent).toHaveBeenCalledWith(FEATURE_KEY, undefined);
    expect(reader.taskReview).toHaveBeenCalledWith(FEATURE_KEY, TASK_ID, undefined);
    expect(reader.reviewDecision).toHaveBeenCalledWith(
      FEATURE_KEY,
      TASK_ID,
      DECISION_HASH,
      undefined
    );
  });

  it("passes only an explicitly resolved per-artifact freshness boundary", async () => {
    const boundary = new Date("2026-08-01T09:00:00.000Z");
    const resolver: CockpitStaleAfterResolver = vi.fn((expectedPath: CockpitArtifactPath) =>
      expectedPath === PATHS.status ? boundary : undefined
    );
    const reader = healthyReader();

    await readCockpitState({ projectPath, reader, staleAfter: resolver });

    expect(resolver).toHaveBeenCalledWith(cockpitArtifactPath(PATHS.status));
    expect(reader.projectStatus).toHaveBeenCalledWith({ staleAfter: boundary });
    expect(reader.projectProfile).toHaveBeenCalledWith(undefined);
    expect(reader.featureIntent).toHaveBeenCalledWith(FEATURE_KEY, undefined);
  });

  it("attributes every quoted value and command to the artifact that supplied it", async () => {
    const state = await readCockpitState({ projectPath, reader: healthyReader() });

    for (const screen of Object.values(state.screens)) {
      for (const entry of screen.artifacts) {
        if (entry.state !== "present") continue;
        expect(entry.sourcePath).toMatch(/^\.visp\//u);
        expect(entry.values.length).toBeGreaterThan(0);
        for (const value of entry.values) {
          expect(value.sourcePath, `${screen.id}/${entry.id}/${value.label}`).toBe(entry.sourcePath);
        }
      }
    }

    expect(state.commandPalette.state).toBe("present");
    if (state.commandPalette.state === "present") {
      const presentedArtifacts = new Set(
        Object.values(state.screens).flatMap((screen) =>
          screen.artifacts.flatMap((entry) => entry.state === "present" ? [entry.sourcePath] : [])
        )
      );
      for (const command of state.commandPalette.commands) {
        expect(command.command.trim().length).toBeGreaterThan(0);
        expect(presentedArtifacts.has(command.sourcePath), command.command).toBe(true);
      }
    }
  });

  it("collects commands only from stored command fields and invents no fallback", async () => {
    const state = await readCockpitState({ projectPath, reader: healthyReader() });
    expect(state.commandPalette.state).toBe("present");
    if (state.commandPalette.state !== "present") throw new Error("Expected stored commands.");

    const commands = state.commandPalette.commands.map(({ command }) => command);
    const allowedStoredCommands = new Set([
      "stored-profile-build",
      "stored-profile-test",
      "stored-profile-lint",
      "stored-profile-typecheck",
      "stored-workflow-command",
      "stored-workflow-next",
      "stored-task-validation",
      "stored-verification-next",
      "stored-review-next",
      "stored-assurance-next",
      "stored-run-command"
    ]);

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => allowedStoredCommands.has(command))).toBe(true);
    expect(commands).toEqual(expect.arrayContaining([
      "stored-workflow-command",
      "stored-task-validation",
      "stored-verification-next",
      "stored-review-next",
      "stored-assurance-next"
    ]));
    expect(commands).not.toContain("verify");
  });

  it("does not invent a verdict or command when no artifact supplies one", async () => {
    const reader = fakeReader({
      projectStatus: vi.fn(async () =>
        present(PATHS.status, {
          initialized: true,
          activeFeaturePath: `.visp/features/${FEATURE_KEY}`,
          activeTaskId: TASK_ID,
          currentState: "implemented",
          lastCommand: "implement"
        })
      ),
      assuranceCase: vi.fn(async () =>
        present(PATHS.assuranceCase, {
          taskId: TASK_ID,
          assuranceProfile: "behavioral",
          claims: [{ id: "claim-with-no-derived-disposition" }]
        })
      )
    });

    const state = await readCockpitState({ projectPath, reader });
    const assurance = artifact(state, "assurance", "assurance-case");

    expect(state.commandPalette).toMatchObject({ state: "unavailable" });
    expect(JSON.stringify(state.commandPalette)).not.toMatch(/visp(?:-hyper)?\s/u);
    expect(assurance.state).toBe("present");
    if (assurance.state === "present") {
      expect(assurance.values.map(({ label }) => label)).not.toContain("Stored verdict");
      expect(assurance.values.map(({ value }) => value)).not.toContain("pass");
      expect(assurance.values.map(({ value }) => value)).not.toContain("ready");
    }
  });
});
