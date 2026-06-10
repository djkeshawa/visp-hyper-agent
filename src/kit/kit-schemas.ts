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
  nextAllowedCommand: z.string().optional()
});
export type KitGateResult = z.infer<typeof kitGateResultSchema>;

const kitContextFileSchema = z
  .object({
    path: z.string(),
    reason: z.string().optional(),
    content: z.string().optional(),
    snippet: z.string().optional()
  })
  .passthrough();

export const kitContextPackSchema = z
  .object({
    taskId: z.string().optional(),
    files: z.array(kitContextFileSchema).optional(),
    includedFiles: z.array(kitContextFileSchema).optional(),
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
