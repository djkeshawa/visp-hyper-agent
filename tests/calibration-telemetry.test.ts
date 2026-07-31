import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  appendAttempt,
  readTelemetry,
  type AttemptPrediction,
  type TelemetryAttempt
} from "../src/telemetry/telemetry-store.js";
import {
  CHEAP_TIER,
  STRONGEST_TIER,
  computeSuggestedTier,
  predictionFromSuggestion,
  wilsonLowerBound
} from "../src/routing/routing-engine.js";
import type { RoutingState } from "../src/routing/routing-state.js";

/**
 * P8-01 — the prediction half of the calibration pair.
 *
 * Calibration asks whether attempts predicted to pass at rate p actually pass at
 * rate p. That needs both halves on the same record, and needs the prediction to
 * have been made without sight of its own outcome. These tests pin the
 * properties that make the stored number mean something.
 */

const COHORT = {
  assuranceProfile: "behavioral" as const,
  host: "codex",
  modelId: "test-scout-model",
  modelVersion: "2026-07",
  projectPreset: "typescript"
};

const EMPTY_ROUTING: RoutingState = { decisions: [], quarantines: [] };

async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vh-calib-"));
  await mkdir(join(path, ".visp", "hyper"), { recursive: true });
  return path;
}

function baseAttempt(overrides: Partial<TelemetryAttempt> = {}): TelemetryAttempt {
  return {
    taskId: "T001",
    taskClass: "bounded_feature",
    riskLevel: "medium",
    riskFactors: [],
    assuranceProfile: COHORT.assuranceProfile,
    host: COHORT.host,
    modelId: COHORT.modelId,
    modelVersion: COHORT.modelVersion,
    projectPreset: COHORT.projectPreset,
    protocolVersion: "local-checked/1.0",
    kitVersion: "none",
    hyperVersion: "0.4.2",
    tier: CHEAP_TIER,
    attempt: 1,
    verifyPassed: true,
    reviewPassed: true,
    verdict: "passed",
    evidenceSource: "local",
    firstAttempt: true,
    sessionId: "vh_calib",
    at: "2026-07-30T00:00:00.000Z",
    prediction: null,
    ...overrides
  };
}

function prediction(overrides: Partial<AttemptPrediction> = {}): AttemptPrediction {
  return {
    passRate: 0.9,
    lowerConfidenceBound: 0.8,
    samples: 40,
    inconclusive: 2,
    suggestedTier: CHEAP_TIER,
    reason: "evidence supports the cheap tier",
    tierUsed: CHEAP_TIER,
    ...overrides
  };
}

describe("P8-01 calibration telemetry", () => {
  it("records written before P8-01 stay readable and are NOT back-filled", async () => {
    // The honest treatment of a record with no prediction is "un-calibratable".
    // Reconstructing one now would derive it from history that already contains
    // this attempt's own outcome, which is the exact failure calibration exists
    // to detect.
    const path = await project();
    const legacy = baseAttempt();
    delete (legacy as Record<string, unknown>).prediction;
    await writeFile(
      join(path, ".visp", "hyper", "telemetry.json"),
      JSON.stringify({ attempts: [legacy], usage: [] }, null, 2),
      "utf8"
    );

    const { data, warnings } = await readTelemetry(path);
    expect(warnings).toEqual([]);
    expect(data.attempts).toHaveLength(1);
    expect(data.attempts[0]!.prediction).toBeNull();
    // Everything else about the legacy record survives the migration.
    expect(data.attempts[0]!.verdict).toBe("passed");
    expect(data.attempts[0]!.taskClass).toBe("bounded_feature");
  });

  it("round-trips a prediction through write and read", async () => {
    const path = await project();
    const written = await appendAttempt(path, {
      ...baseAttempt(),
      prediction: prediction()
    });
    expect(written.prediction).toEqual(prediction());

    const { data, warnings } = await readTelemetry(path);
    expect(warnings).toEqual([]);
    expect(data.attempts[0]!.prediction).toEqual(prediction());
  });

  it("an omitted prediction persists as null rather than undefined", async () => {
    const path = await project();
    const { prediction: _drop, ...withoutPrediction } = baseAttempt();
    const written = await appendAttempt(path, withoutPrediction);
    expect(written.prediction).toBeNull();

    const raw = JSON.parse(
      await readFile(join(path, ".visp", "hyper", "telemetry.json"), "utf8")
    ) as { attempts: { prediction: unknown }[] };
    expect(raw.attempts[0]!.prediction).toBeNull();
  });

  it("a prediction cannot see its own outcome", async () => {
    // The prediction for attempt N must be computed from attempts 1..N-1. If it
    // could see attempt N, every prediction would be perfectly calibrated and
    // the measurement would be worthless.
    const path = await project();
    const priorPasses = 8;
    const priorFails = 2;
    const attempts: TelemetryAttempt[] = [
      ...Array.from({ length: priorPasses }, (_, i) =>
        baseAttempt({ taskId: `P${i}`, verdict: "passed" })
      ),
      ...Array.from({ length: priorFails }, (_, i) =>
        baseAttempt({ taskId: `F${i}`, verdict: "failed", verifyPassed: false })
      )
    ];

    const suggestion = computeSuggestedTier({
      task: {
        id: "T-next",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        assuranceProfile: COHORT.assuranceProfile
      },
      cohort: COHORT,
      attempts,
      routingState: EMPTY_ROUTING,
      sessionCount: 1
    });
    const recorded = predictionFromSuggestion(suggestion, CHEAP_TIER);

    // Ten prior decided attempts, eight of them passes.
    expect(recorded.samples).toBe(priorPasses + priorFails);
    expect(recorded.passRate).toBeCloseTo(0.8, 10);
    expect(recorded.lowerConfidenceBound).toBeCloseTo(
      wilsonLowerBound(priorPasses, priorPasses + priorFails)!,
      10
    );
  });

  it("reports an uninformed prediction honestly instead of guessing", async () => {
    // No history means no rate. Null is the truthful answer; 0 or 0.5 would both
    // be inventions that a calibration report would then average in.
    const suggestion = computeSuggestedTier({
      task: {
        id: "T-cold",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        assuranceProfile: COHORT.assuranceProfile
      },
      cohort: COHORT,
      attempts: [],
      routingState: EMPTY_ROUTING,
      sessionCount: 1
    });
    const recorded = predictionFromSuggestion(suggestion, CHEAP_TIER);
    expect(recorded.samples).toBe(0);
    expect(recorded.passRate).toBeNull();
    expect(recorded.lowerConfidenceBound).toBeNull();
  });

  it("records the tier actually used, so a mismatch stays visible", async () => {
    const suggestion = computeSuggestedTier({
      task: {
        id: "T-mismatch",
        taskClass: "bounded_feature",
        riskLevel: "high",
        assuranceProfile: COHORT.assuranceProfile
      },
      cohort: COHORT,
      attempts: [],
      routingState: EMPTY_ROUTING,
      sessionCount: 1
    });
    // High risk forces the strongest tier; suppose the caller ran the cheap one.
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    const recorded = predictionFromSuggestion(suggestion, CHEAP_TIER);
    expect(recorded.suggestedTier).toBe(STRONGEST_TIER);
    expect(recorded.tierUsed).toBe(CHEAP_TIER);
  });

  it("storing predictions changes no routing decision", async () => {
    // P8-01 adds an observation. If recording it moved a routing outcome, the
    // measurement would be altering the thing it measures.
    const withoutPredictions = Array.from({ length: 40 }, (_, i) =>
      baseAttempt({ taskId: `T${i}`, verdict: i < 38 ? "passed" : "failed" })
    );
    const withPredictions = withoutPredictions.map((entry) => ({
      ...entry,
      prediction: prediction({ passRate: 0.1, lowerConfidenceBound: 0.05 })
    }));

    const task = {
      id: "T-compare",
      taskClass: "bounded_feature" as const,
      riskLevel: "medium" as const,
      assuranceProfile: COHORT.assuranceProfile
    };
    const a = computeSuggestedTier({
      task,
      cohort: COHORT,
      attempts: withoutPredictions,
      routingState: EMPTY_ROUTING,
      sessionCount: 5
    });
    const b = computeSuggestedTier({
      task,
      cohort: COHORT,
      attempts: withPredictions,
      routingState: EMPTY_ROUTING,
      sessionCount: 5
    });

    // Identical, despite the stored predictions claiming a 10% pass rate.
    expect(b).toEqual(a);
  });

  it("a stored prediction never raises the suggested tier's authority", async () => {
    // The invariant this phase is most likely to erode: confidence must not
    // expand permission. A perfect prediction attached to a critical task still
    // gets the strongest tier.
    const confident = Array.from({ length: 60 }, (_, i) =>
      baseAttempt({
        taskId: `C${i}`,
        assuranceProfile: "critical",
        prediction: prediction({ passRate: 1, lowerConfidenceBound: 1, samples: 60 })
      })
    );
    const suggestion = computeSuggestedTier({
      task: {
        id: "T-critical",
        taskClass: "bounded_feature",
        riskLevel: "medium",
        assuranceProfile: "critical"
      },
      cohort: { ...COHORT, assuranceProfile: "critical" },
      attempts: confident,
      routingState: EMPTY_ROUTING,
      sessionCount: 10
    });
    expect(suggestion.suggestedTier).toBe(STRONGEST_TIER);
    expect(suggestion.reason).toMatch(/critical/u);
  });

  it("rejects an out-of-range prediction rather than storing nonsense", async () => {
    const path = await project();
    await writeFile(
      join(path, ".visp", "hyper", "telemetry.json"),
      JSON.stringify(
        { attempts: [baseAttempt({ prediction: prediction({ passRate: 1.5 }) })], usage: [] },
        null,
        2
      ),
      "utf8"
    );
    // A schema-invalid store resolves to empty plus a warning, never to a
    // silently accepted impossible probability.
    const { data, warnings } = await readTelemetry(path);
    expect(data.attempts).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
