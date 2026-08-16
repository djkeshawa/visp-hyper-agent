import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeNodeExecutable } from "./fake-executable.js";

export interface ShimResponse {
  stdout: object | string;
  exitCode?: number;
  delayMs?: number;
}

/**
 * A spec keyed by either the command plus its first positional argument or by
 * the first CLI argument (the visp subcommand), e.g.
 * `{ "gate next": { stdout: { ... } }, gate: { stdout: { ... }, exitCode: 1 } }`.
 * The more specific key wins, so `gate next` and `gate implement` can return
 * different authority results while older first-token specs keep working.
 * Special key "garbage" is not used; emit a string `stdout` to produce non-JSON.
 */
export type ShimSpec = Record<string, ShimResponse>;

export interface VispShim {
  /** Absolute path to the executable shim, pass as `binary` to the bridge. */
  binary: string;
  /** Absolute path to a file the shim appends its received argv to (newline-delimited JSON arrays). */
  argvLogPath: string;
}

const CURRENT_KIT_TIMESTAMP = "2026-07-16T00:00:00.000Z";

type FixtureOverrides = Record<string, unknown>;

type PolicyValidateFixtureOverrides = FixtureOverrides & {
  success?: boolean;
  validation?: {
    passed?: boolean;
    errors?: string[];
    [key: string]: unknown;
  };
};

/** Build a live-shaped current Kit policy-validation result. */
export function policyValidateFixture(
  overrides: PolicyValidateFixtureOverrides = {}
): Record<string, unknown> {
  const validationOverrides = overrides.validation ?? {};
  const success = overrides.success ?? validationOverrides.passed ?? true;
  const passed = validationOverrides.passed ?? overrides.success ?? true;
  const errors =
    validationOverrides.errors ??
    (passed ? [] : ["Policy validation failed in the authoritative Kit fixture."]);

  return {
    mode: "validate",
    command: "validate",
    targetPath: "/repo",
    policyPath: ".visp/policy.json",
    source: "file",
    dryRun: false,
    created: false,
    updated: false,
    warnings: [],
    nextCommand: success
      ? "visp policy show"
      : "Fix .visp/policy.json and run `visp policy validate`.",
    ...overrides,
    // Keep the default path coherent while allowing tests to construct an
    // intentional contradiction by explicitly overriding both values.
    success,
    validation: {
      ...validationOverrides,
      passed,
      errors
    }
  };
}

/** Build one complete task matching the current Kit task artifact schema. */
export function authoritativeTaskFixture(
  overrides: FixtureOverrides = {}
): Record<string, unknown> {
  return {
    id: "T001",
    title: "First task",
    description: "Implement the first task.",
    requirementIds: ["REQ001"],
    acceptanceCriterionIds: ["AC001"],
    dependsOn: [],
    allowedFiles: ["src/feature.ts"],
    expectedFiles: ["tests/feature.test.ts"],
    forbiddenFiles: [],
    validationCommands: ["pnpm typecheck", "pnpm test"],
    status: "ready",
    parallelizable: false,
    riskLevel: "high",
    ...overrides
  };
}

/** Build a complete current Kit task graph with deterministic timestamps. */
export function authoritativeTaskGraphFixture(
  overrides: FixtureOverrides = {}
): Record<string, unknown> {
  return {
    featureId: "001",
    featureSlug: "pipeline",
    status: "ready",
    tasks: [authoritativeTaskFixture()],
    createdAt: CURRENT_KIT_TIMESTAMP,
    updatedAt: CURRENT_KIT_TIMESTAMP,
    ...overrides
  };
}

/** Build a complete current Kit context pack for configured strict-run tests. */
export function authoritativeContextPackFixture(
  overrides: FixtureOverrides = {}
): Record<string, unknown> {
  return {
    id: "CTX-T001",
    featureId: "001",
    featureSlug: "pipeline",
    taskId: "T001",
    budgetMode: "strict",
    estimatedTokens: {
      input: 1200,
      expectedOutput: 800,
      total: 2000,
      maxInput: 8000,
      mode: "strict",
      estimator: "model-profile-conservative",
      lowerBound: 600,
      upperBound: 1200,
      profile: "generic-code",
      uncertainty: "model-tokenizer-not-specified"
    },
    overBudget: false,
    recommendation: "OK",
    warnings: [],
    selectedTask: authoritativeTaskFixture(),
    includedRequirements: [
      {
        id: "REQ001",
        featureId: "001",
        title: "Implement the first task",
        description: "The first task is implemented within its declared scope.",
        source: "user",
        priority: "must",
        acceptanceCriteria: [
          {
            id: "AC001",
            requirementId: "REQ001",
            description: "The task passes its declared validation commands.",
            testable: true,
            validationMethod: "integration"
          }
        ],
        assumptions: [],
        outOfScope: []
      }
    ],
    includedAcceptanceCriteria: [
      {
        id: "AC001",
        requirementId: "REQ001",
        description: "The task passes its declared validation commands.",
        testable: true,
        validationMethod: "integration"
      }
    ],
    includedPlanDecisions: [],
    includedRisks: [],
    includedDependencyTasks: [],
    includedConstitutionRules: [],
    includedProjectContext: {
      summary: "Test project context.",
      patterns: "Use the existing TypeScript conventions.",
      warnings: []
    },
    artifactProvenance: [],
    includedFiles: [
      {
        path: "src/feature.ts",
        reason: "Authoritative task target.",
        includeMode: "full",
        hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        language: "TypeScript",
        sizeBytes: 24,
        tokenEstimate: 8,
        summaryAvailable: true,
        snippetIncluded: false,
        summary: "Exports the feature fixture value."
      }
    ],
    includedSnippets: [],
    validationCommands: ["pnpm typecheck", "pnpm test"],
    constraints: ["Change only the declared task scope."],
    instructions: ["Implement only task T001."],
    strictnessMode: "strict",
    policyStatus: "valid",
    gateStatus: "allowed",
    failedGateRules: [],
    blockedCommands: [],
    policyGate: {
      strictnessMode: "strict",
      policyStatus: "valid",
      stage: "implement",
      allowed: true,
      failedRules: [],
      blockedCommands: [],
      overriddenRules: [],
      appliedOverrides: [],
      warnings: [],
      nextAllowedCommand: "Read the current task prompt and implement only the selected task.",
      nextCommand: "visp context --next",
      evaluatedAt: CURRENT_KIT_TIMESTAMP
    },
    createdAt: CURRENT_KIT_TIMESTAMP,
    updatedAt: CURRENT_KIT_TIMESTAMP,
    ...overrides
  };
}

type GateRuleFixture = {
  ruleId: string;
  severity?: "info" | "warning" | "error";
  message?: string;
  recommendation?: string;
  evidence?: string;
  [key: string]: unknown;
};

/** Build a complete current Kit GateResult while keeping each test concise. */
export function gateResultFixture(
  overrides: Record<string, unknown> & { failedRules?: GateRuleFixture[] } = {}
): Record<string, unknown> {
  const allowed = typeof overrides.allowed === "boolean" ? overrides.allowed : true;
  const stage = typeof overrides.stage === "string" ? overrides.stage : "implement";
  const failedRules = (overrides.failedRules ?? []).map((rule) => ({
    severity: "error",
    message: `Rule ${rule.ruleId} failed.`,
    recommendation: "Follow the Kit-provided recovery command.",
    evidence: "Fixture evidence.",
    ...rule
  }));
  return {
    targetPath: "/repo",
    strictnessMode: "strict",
    dryRun: false,
    feature: { id: "001", slug: "pipeline" },
    taskId: "T001",
    passedRules: [],
    warnings: [],
    blockedCommands: [],
    overriddenRules: [],
    appliedOverrides: [],
    nextAllowedCommand: "Use the Kit-provided next command.",
    nextCommand: "visp implement",
    reportPath: `.visp/reports/gate-${stage}.md`,
    evaluatedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
    success: allowed,
    stage,
    allowed,
    failedRules
  };
}

/**
 * Writes an executable shim that switches on its first argument and prints
 * canned JSON. Pass `binary` to KitCommandBridge / detectVisp directly.
 *
 * {@link writeNodeExecutable} owns the platform shape.
 */
export async function createVispShim(spec: ShimSpec): Promise<VispShim> {
  const dir = await mkdtemp(join(tmpdir(), "visp-shim-"));
  const argvLogPath = join(dir, "argv.log");

  const body = `"use strict";
const { appendFileSync, writeSync } = require("node:fs");

const spec = ${JSON.stringify(spec)};
const argvLogPath = ${JSON.stringify(argvLogPath)};
const args = process.argv.slice(2);

appendFileSync(argvLogPath, JSON.stringify(args) + "\\n");

const commandArgs = args.filter((arg) => !arg.startsWith("-"));
const subcommand = commandArgs[0];
const commandKey = commandArgs.slice(0, 2).join(" ");
const response = (commandKey ? spec[commandKey] : undefined) ?? (subcommand ? spec[subcommand] : undefined);

if (!response) {
  process.stderr.write("unknown subcommand: " + String(subcommand) + "\\n");
  process.exit(127);
}

const finish = () => {
  const out = typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout);
  writeSync(process.stdout.fd, out);
  process.exitCode = response.exitCode ?? 0;
};

if (typeof response.delayMs === "number" && response.delayMs > 0) {
  setTimeout(finish, response.delayMs);
} else {
  finish();
}
`;

  const binary = await writeNodeExecutable(dir, "visp", body);

  return { binary, argvLogPath };
}
