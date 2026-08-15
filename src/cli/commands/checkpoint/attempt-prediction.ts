/**
 * What a checkpoint predicts about the attempt it is about to record.
 *
 * Shared by the command itself and by the configured Kit checkpoint, which is
 * the only reason it is not private to either.
 */

import { readState } from "../../../core/session-manager.js";
import { computeSuggestedTier, predictionFromSuggestion } from "../../../routing/routing-engine.js";
import { readRoutingState } from "../../../routing/routing-state.js";
import { readTelemetry } from "../../../telemetry/telemetry-store.js";
import type { AttemptPrediction } from "../../../telemetry/telemetry-store.js";

// Default tier recorded in telemetry when the orchestrator does not report
// which tier actually executed the task via `--tier`.
export const DEFAULT_TIER = "implementer";

/**
 * Compute the calibration prediction for an attempt about to be recorded (P8-01).
 *
 * Reads telemetry BEFORE the append, so the prediction cannot see its own
 * outcome — a prediction that can is trivially well calibrated and worthless.
 *
 * Returns null when routing cannot be computed. An absent prediction is recorded
 * honestly as un-calibratable; it is never invented after the fact, which is the
 * failure calibration exists to detect.
 *
 * Observational only: it never changes a routing decision and never widens what
 * an action may touch.
 */
export async function predictionForAttempt(input: {
  projectPath: string;
  task: Parameters<typeof computeSuggestedTier>[0]["task"];
  cohort: Parameters<typeof computeSuggestedTier>[0]["cohort"];
  tierUsed: string;
}): Promise<AttemptPrediction | null> {
  try {
    const { data: telemetry } = await readTelemetry(input.projectPath);
    const { state: routingState } = await readRoutingState(input.projectPath);
    const hyperState = await readState(input.projectPath);
    const suggestion = computeSuggestedTier({
      task: input.task,
      cohort: input.cohort,
      attempts: telemetry.attempts,
      routingState,
      sessionCount: Object.keys(hyperState.sessions).length
    });
    return predictionFromSuggestion(suggestion, input.tierUsed);
  } catch {
    return null;
  }
}
