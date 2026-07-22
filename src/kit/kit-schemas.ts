import { z } from "zod";

// Partial-mirror schemas of the external `visp` CLI's `--json` output.
// We only describe the fields visp-hyper-agent consumes; unknown extra fields
// are intentionally tolerated (zod objects strip unknowns — no `.strict()`).

const kitFeatureRefSchema = z.object({
  id: z.string(),
  slug: z.string().optional()
});

const kitActiveTaskSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  status: z.string().optional()
});

export const kitStatusSchema = z.object({
  success: z.boolean(),
  initialized: z.boolean(),
  activeFeature: kitFeatureRefSchema.nullish(),
  activeTask: kitActiveTaskSchema.nullish(),
  featureState: z.string().optional()
});
export type KitStatus = z.infer<typeof kitStatusSchema>;

const kitFailedRuleSchema = z
  .object({
    ruleId: z.string(),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string(),
    recommendation: z.string(),
    evidence: z.string()
  })
  .passthrough();

const kitBlockedCommandSchema = z.object({
  command: z.string(),
  reason: z.string(),
  ruleId: z.string()
});

const kitGateStageSchema = z.enum([
  "next",
  "setup",
  "feature",
  "clarify",
  "spec",
  "plan",
  "tasks",
  "context",
  "implement",
  "verify",
  "review",
  "reconcile",
  "pr"
]);

const kitAppliedOverrideSchema = z
  .object({
    overrideId: z.string(),
    ruleId: z.string(),
    scope: z.enum(["project", "feature", "task", "stage"]),
    reason: z.string(),
    expiresAt: z.string().nullable(),
    appliedToStage: kitGateStageSchema,
    appliedToFeatureId: z.string().nullable(),
    appliedToTaskId: z.string().nullable()
  })
  .passthrough();

export const kitGateResultSchema = z
  .object({
    success: z.boolean(),
    targetPath: z.string(),
    stage: kitGateStageSchema,
    strictnessMode: z.enum(["relaxed", "standard", "strict", "locked"]),
    allowed: z.boolean(),
    dryRun: z.boolean(),
    feature: z.object({ id: z.string(), slug: z.string() }).nullable(),
    taskId: z.string().nullable(),
    passedRules: z.array(z.string()),
    failedRules: z.array(kitFailedRuleSchema),
    blockedCommands: z.array(kitBlockedCommandSchema),
    warnings: z.array(z.string()),
    overriddenRules: z.array(z.string()),
    appliedOverrides: z.array(kitAppliedOverrideSchema),
    // `nextAllowedCommand` is a human sentence (e.g. 'Run visp feature "<x>".');
    // `nextCommand` is the bare machine-runnable form (e.g. 'visp feature "<x>"')
    // when the kit provides it. Prefer the bare field for weak-model handoffs.
    nextAllowedCommand: z.string(),
    nextCommand: z.string().optional(),
    reportPath: z.string(),
    evaluatedAt: z.string()
  })
  .passthrough();
export type KitGateResult = z.infer<typeof kitGateResultSchema>;

export const kitPolicyValidationResultSchema = z
  .object({
    success: z.boolean(),
    validation: z
      .object({
        passed: z.boolean(),
        errors: z.array(z.string())
      })
      .passthrough(),
    warnings: z.array(z.string()),
    nextCommand: z.string()
  })
  .passthrough()
  // Preserve the exact nested Kit result while keeping the legacy doctor
  // consumer source-compatible during this bounded contract correction.
  .transform((policy) => ({ ...policy, errors: policy.validation.errors }));
export type KitPolicyValidationResult = z.infer<typeof kitPolicyValidationResultSchema>;

const kitAuthoritativeIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const kitAuthoritativeTaskSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    requirementIds: z.array(kitAuthoritativeIdSchema),
    acceptanceCriterionIds: z.array(kitAuthoritativeIdSchema),
    dependsOn: z.array(kitAuthoritativeIdSchema),
    allowedFiles: z.array(z.string().min(1)),
    expectedFiles: z.array(z.string().min(1)).optional(),
    forbiddenFiles: z.array(z.string().min(1)).optional(),
    validationCommands: z.array(z.string().min(1)),
    status: z.enum(["pending", "ready", "in_progress", "blocked", "done", "verified"]),
    parallelizable: z.boolean(),
    riskLevel: z.enum(["low", "medium", "high"])
  })
  .passthrough();

export const kitAuthoritativeTaskGraphSchema = z
  .object({
    featureId: kitAuthoritativeIdSchema,
    featureSlug: z.string().min(1).optional(),
    status: z.enum(["draft_invalid", "draft", "ready"]).optional(),
    tasks: z.array(kitAuthoritativeTaskSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .passthrough();
export type KitAuthoritativeTaskGraph = z.infer<typeof kitAuthoritativeTaskGraphSchema>;

const kitContextFileSchema = z
  .object({
    path: z.string(),
    reason: z.string().optional(),
    content: z.string().optional(),
    snippet: z.string().optional(),
    hash: z.string().optional()
  })
  .passthrough();

const kitArtifactProvenanceSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  hash: z.string().min(1),
  hashAlgorithm: z.literal("sha256")
});

const kitAuthoritativeAcceptanceCriterionSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    requirementId: kitAuthoritativeIdSchema,
    description: z.string().min(1),
    testable: z.boolean(),
    validationMethod: z.enum(["unit", "integration", "e2e", "manual", "static"])
  })
  .passthrough();

const kitAuthoritativeAssumptionSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    description: z.string().min(1)
  })
  .passthrough();

const kitAuthoritativeRequirementSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    featureId: kitAuthoritativeIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    source: z.enum(["user", "clarification", "derived"]),
    priority: z.enum(["must", "should", "could"]),
    acceptanceCriteria: z.array(kitAuthoritativeAcceptanceCriterionSchema),
    assumptions: z.array(kitAuthoritativeAssumptionSchema),
    outOfScope: z.array(z.string().min(1))
  })
  .passthrough();

const kitAuthoritativePlanDecisionSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    requirementIds: z.array(kitAuthoritativeIdSchema)
  })
  .passthrough();

const kitAuthoritativePlanRiskSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    description: z.string().min(1),
    level: z.enum(["low", "medium", "high"]),
    mitigation: z.string().min(1),
    requirementIds: z.array(kitAuthoritativeIdSchema)
  })
  .passthrough();

const kitAuthoritativeDependencyTaskSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    title: z.string().min(1),
    status: z.string().min(1),
    dependsOn: z.array(kitAuthoritativeIdSchema)
  })
  .passthrough();

const kitAuthoritativeConstitutionRuleSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    text: z.string().min(1)
  })
  .passthrough();

const kitAuthoritativeContextSnippetSchema = z
  .object({
    filePath: z.string().min(1),
    reason: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    content: z.string().min(1),
    tokenEstimate: z.number().int().nonnegative()
  })
  .passthrough()
  .refine((snippet) => snippet.endLine >= snippet.startLine, {
    message: "endLine must be greater than or equal to startLine.",
    path: ["endLine"]
  });

const kitAuthoritativePolicyGateSchema = z
  .object({
    strictnessMode: z.enum(["relaxed", "standard", "strict", "locked"]),
    policyStatus: z.enum(["valid", "missing", "invalid", "default"]),
    stage: kitGateStageSchema,
    allowed: z.boolean(),
    failedRules: z.array(kitFailedRuleSchema),
    blockedCommands: z.array(kitBlockedCommandSchema),
    overriddenRules: z.array(kitAuthoritativeIdSchema),
    appliedOverrides: z.array(kitAppliedOverrideSchema),
    warnings: z.array(z.string().min(1)),
    nextAllowedCommand: z.string().min(1),
    nextCommand: z.string().min(1).optional(),
    evaluatedAt: z.string().datetime()
  })
  .passthrough();

export const kitContextPackSchema = z
  .object({
    taskId: z.string().optional(),
    files: z.array(kitContextFileSchema).optional(),
    includedFiles: z.array(kitContextFileSchema).optional(),
    artifactProvenance: z.array(kitArtifactProvenanceSchema).optional(),
    rules: z.array(z.string()).optional(),
    validationCommands: z.array(z.string()).optional()
  })
  .passthrough();
export type KitContextPack = z.infer<typeof kitContextPackSchema>;

const kitAuthoritativeContextFileSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
    includeMode: z.enum(["summary", "snippet", "full", "new-file"]),
    hash: z.string().min(1),
    language: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    tokenEstimate: z.number().int().nonnegative(),
    summaryAvailable: z.boolean(),
    snippetIncluded: z.boolean(),
    summary: z.string().optional(),
    warning: z.string().optional()
  })
  .passthrough();

const kitContextTokenEstimateSchema = z.object({
  input: z.number().int().nonnegative(),
  expectedOutput: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  maxInput: z.number().int().positive(),
  mode: z.enum(["lean", "balanced", "strict"]),
  estimator: z.enum(["chars-divided-by-four", "model-profile-conservative", "heuristic-v1"]),
  lowerBound: z.number().int().nonnegative().optional(),
  upperBound: z.number().int().nonnegative().optional(),
  profile: z.string().optional(),
  uncertainty: z.string().optional()
});

/** Required current Kit context shape used only by configured strict run. */
export const kitAuthoritativeContextPackSchema = z
  .object({
    id: kitAuthoritativeIdSchema,
    featureId: kitAuthoritativeIdSchema,
    featureSlug: z.string().min(1),
    taskId: z.string().min(1),
    budgetMode: z.enum(["lean", "balanced", "strict"]),
    estimatedTokens: kitContextTokenEstimateSchema,
    overBudget: z.boolean(),
    recommendation: z.string().min(1),
    warnings: z.array(z.string().min(1)),
    selectedTask: kitAuthoritativeTaskSchema,
    includedRequirements: z.array(kitAuthoritativeRequirementSchema),
    includedAcceptanceCriteria: z.array(kitAuthoritativeAcceptanceCriterionSchema),
    includedPlanDecisions: z.array(kitAuthoritativePlanDecisionSchema),
    includedRisks: z.array(kitAuthoritativePlanRiskSchema),
    includedDependencyTasks: z.array(kitAuthoritativeDependencyTaskSchema),
    includedConstitutionRules: z.array(kitAuthoritativeConstitutionRuleSchema),
    includedProjectContext: z
      .object({
        summary: z.string(),
        patterns: z.string(),
        warnings: z.array(z.string().min(1))
      })
      .passthrough(),
    artifactProvenance: z.array(kitArtifactProvenanceSchema),
    includedFiles: z.array(kitAuthoritativeContextFileSchema),
    includedSnippets: z.array(kitAuthoritativeContextSnippetSchema),
    validationCommands: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    instructions: z.array(z.string().min(1)),
    strictnessMode: z.enum(["relaxed", "standard", "strict", "locked"]).optional(),
    policyStatus: z.enum(["valid", "missing", "invalid", "default"]).optional(),
    gateStatus: z.enum(["allowed", "blocked", "warnings", "not_evaluated"]).optional(),
    failedGateRules: z.array(kitFailedRuleSchema).optional(),
    blockedCommands: z.array(kitBlockedCommandSchema).optional(),
    policyGate: kitAuthoritativePolicyGateSchema.optional(),
    trimming: z
      .object({
        removedSnippetCount: z.number().int().nonnegative(),
        removedPatterns: z.boolean(),
        heavilyTrimmed: z.boolean()
      })
      .passthrough()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .passthrough();
export type KitAuthoritativeContextPack = z.infer<typeof kitAuthoritativeContextPackSchema>;

// Verify / review / reconcile share a minimal summary surface. We keep a
// passthrough `findings`-like array when present without over-specifying it.
const kitSummaryBaseShape = {
  success: z.boolean(),
  warnings: z.array(z.string()).optional(),
  errors: z.array(z.string()).optional(),
  findings: z.array(z.unknown()).optional()
};

export const kitVerifySummarySchema = z.object(kitSummaryBaseShape);
export type KitVerifySummary = z.infer<typeof kitVerifySummarySchema>;

export const kitReviewSummarySchema = z.object(kitSummaryBaseShape);
export type KitReviewSummary = z.infer<typeof kitReviewSummarySchema>;

export const kitReconcileSummarySchema = z.object(kitSummaryBaseShape);
export type KitReconcileSummary = z.infer<typeof kitReconcileSummarySchema>;

export const kitBudgetResultSchema = z.object({
  success: z.boolean()
});
export type KitBudgetResult = z.infer<typeof kitBudgetResultSchema>;

export const kitNextSchema = z.object({
  success: z.boolean().optional(),
  nextCommand: z.string().optional(),
  state: z.string().optional(),
  reason: z.string().optional(),
  allowed: z.boolean().optional()
});
export type KitNext = z.infer<typeof kitNextSchema>;

const kitIntegrationContractFeatureSchema = z.object({
  id: z.string(),
  slug: z.string(),
  key: z.string(),
  path: z.string()
});

const kitIntegrationContractTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string()
});

const kitIntegrationCapabilitiesSchema = z
  .object({
    deterministic: z
      .object({
        noLlmCalls: z.boolean().optional(),
        localArtifacts: z.boolean().optional(),
        jsonOutput: z.boolean().optional()
      })
      .optional(),
    governance: z
      .object({
        policyAsCode: z.boolean().optional(),
        failClosedGates: z.boolean().optional(),
        overrideAuditTrail: z.boolean().optional(),
        sourceEditsRequireImplementGate: z.boolean().optional(),
        contextPackRequiredForImplementation: z.boolean().optional()
      })
      .optional(),
    contextGrounding: z
      .object({
        phaseLevelArtifacts: z.boolean().optional(),
        taskScopedContextPacks: z.boolean().optional(),
        artifactProvenance: z.boolean().optional(),
        currentTaskPrompt: z.boolean().optional(),
        implementationChecklist: z.boolean().optional(),
        orchestratorReadContract: z.boolean().optional()
      })
      .optional(),
    evidence: z
      .object({
        verification: z.boolean().optional(),
        review: z.boolean().optional(),
        reconciliation: z.boolean().optional(),
        traceability: z.boolean().optional(),
        budgetTelemetry: z.boolean().optional(),
        prReadiness: z.boolean().optional()
      })
      .optional(),
    enforcementSurfaces: z
      .object({
        claudePreToolUseHook: z.boolean().optional(),
        gitPreCommitHook: z.boolean().optional(),
        ciPolicyGate: z.boolean().optional()
      })
      .optional()
  })
  .optional();

const kitIntegrationWorkflowSchema = z
  .object({
    strictSequence: z.array(z.string()).optional(),
    implementationReadSet: z.array(z.string()).optional(),
    checkpointSequence: z.array(z.string()).optional(),
    failClosedOn: z.array(z.string()).optional(),
    freshnessChecks: z.array(z.string()).optional(),
    humanOverride: z
      .object({
        requiresReason: z.boolean().optional(),
        command: z.array(z.string()).optional(),
        artifact: z.string().optional()
      })
      .optional()
  })
  .optional();

const kitIntegrationOrchestratorArtifactSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    role: z.string(),
    mimeType: z.string(),
    requiredFor: z.array(z.string()).optional(),
    freshness: z.string().optional()
  })
  .passthrough();

const kitIntegrationOrchestratorSchema = z
  .object({
    readContractVersion: z.string().optional(),
    requiredArtifacts: z.array(kitIntegrationOrchestratorArtifactSchema).optional(),
    freshnessPolicy: z
      .object({
        contextPackHashPinned: z.boolean().optional(),
        provenanceArtifactsHashPinned: z.boolean().optional(),
        staleContextBlocks: z.array(z.string()).optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()
  .optional();

export const kitIntegrationContractSchema = z
  .object({
    success: z.literal(true),
    contractVersion: z.literal("2.0"),
    kit: z.object({
      packageName: z.string(),
      cliName: z.string(),
      version: z.string()
    }),
    targetPath: z.string(),
    initialized: z.boolean(),
    activeFeature: kitIntegrationContractFeatureSchema.nullable(),
    activeTask: kitIntegrationContractTaskSchema.nullable(),
    commands: z.record(z.array(z.string())),
    capabilities: kitIntegrationCapabilitiesSchema,
    workflow: kitIntegrationWorkflowSchema,
    artifacts: z.object({
      kitSignals: z.array(z.string()),
      projectStatus: z.string(),
      projectProfile: z.string(),
      featureRoot: z.string(),
      featureDir: z.string(),
      taskGraph: z.string(),
      contextPack: z.string(),
      contextPrompt: z.string()
    }),
    orchestrator: kitIntegrationOrchestratorSchema,
    warnings: z.array(z.string()).optional()
  })
  .passthrough();
export type KitIntegrationContract = z.infer<typeof kitIntegrationContractSchema>;

// Partial mirror of a feature's `task-graph.json`. Only the fields the pipeline
// engine consumes are described; unknown extras are tolerated (no `.strict()`).
export const kitTaskSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  requirementIds: z.array(z.string()).optional(),
  acceptanceCriterionIds: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).default([]),
  allowedFiles: z.array(z.string()).optional(),
  expectedFiles: z.array(z.string()).optional(),
  forbiddenFiles: z.array(z.string()).optional(),
  validationCommands: z.array(z.string()).optional(),
  status: z.string().optional(),
  parallelizable: z.boolean().optional(),
  riskLevel: z.string().optional()
});
export type KitTask = z.infer<typeof kitTaskSchema>;

export const kitTaskGraphSchema = z.object({
  featureId: z.string().optional(),
  featureSlug: z.string().optional(),
  tasks: z.array(kitTaskSchema)
});
export type KitTaskGraph = z.infer<typeof kitTaskGraphSchema>;
