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

// `failedRules` arrives as either bare rule-id strings or rule objects depending
// on the subcommand; normalize both to a `{ ruleId, ... }` object shape.
const kitFailedRuleSchema = z.union([
  z.string().transform((ruleId) => ({ ruleId })),
  z.object({
    ruleId: z.string(),
    severity: z.string().optional(),
    message: z.string().optional()
  })
]);

const kitBlockedCommandSchema = z.object({
  command: z.string(),
  reason: z.string().optional(),
  ruleId: z.string().optional()
});

export const kitGateResultSchema = z.object({
  success: z.boolean().optional(),
  stage: z.string().optional(),
  allowed: z.boolean(),
  strictnessMode: z.string().optional(),
  failedRules: z.array(kitFailedRuleSchema).default([]),
  blockedCommands: z.array(kitBlockedCommandSchema).optional(),
  // `nextAllowedCommand` is a human sentence (e.g. 'Run visp feature "<x>".');
  // `nextCommand` is the bare machine-runnable form (e.g. 'visp feature "<x>"')
  // when the kit provides it. Prefer the bare field for weak-model handoffs.
  nextAllowedCommand: z.string().optional(),
  nextCommand: z.string().optional()
});
export type KitGateResult = z.infer<typeof kitGateResultSchema>;

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
  label: z.string(),
  path: z.string(),
  hash: z.string(),
  hashAlgorithm: z.literal("sha256")
});

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

export const workflowActionV2Schema = z.object({
  protocolVersion: z.literal("2.0"),
  phase: z.enum(["clarify", "specify", "plan", "task", "implement", "verify"]),
  taskId: z.string().nullable(),
  goal: z.string(),
  requiredReads: z.array(z.object({ path: z.string(), role: z.string(), sha256: z.string() })),
  writablePaths: z.array(z.string()),
  forbiddenPaths: z.array(z.string()),
  acceptanceOracles: z.array(z.object({ id: z.string(), expectedBehavior: z.string(), validation: z.string() })),
  validationCommands: z.array(z.string()),
  assuranceLevel: z.enum(["kit_strict", "local_checked", "advisory"]),
  verdict: z.enum(["ready", "blocked", "inconclusive"]),
  findings: z.array(z.string()),
  nextCommand: z.string()
});
export type WorkflowActionV2 = z.infer<typeof workflowActionV2Schema>;

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
    success: z.boolean(),
    contractVersion: z.string(),
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
