// One place that answers "Kit is unusable — what should I actually run?".
//
// This exists because the previous answer was a single sentence offering two
// commands with no basis for choosing between them ("Run visp setup, or
// visp-kit init for a new project"). Three of five independent evaluators
// driving the published toolchain hit that message and had to guess.
//
// The subtlety that makes a naive fix wrong: `detectVisp` reports
// `no_kit_signals` whenever the project has no `.visp/` artifacts, and it
// checks that BEFORE probing the binary. So "no signals" does not imply the
// engine is installed — advising `visp-kit init` there sends a user without
// Kit to a command-not-found. Reachability has to be established separately.

import { resolveKitBinary } from "./kit-binary-resolver.js";

export type KitGuidance = {
  /** Human-readable, already formatted for direct printing. */
  readonly message: string;
  /** The single command to run, for machine-readable surfaces. */
  readonly nextCommand: string;
};

async function kitBinaryReachable(projectPath: string): Promise<boolean> {
  const resolution = await resolveKitBinary({ projectPath });
  // `found` is the only honest signal: the resolver returns ok:true with a
  // guessed `visp` even when nothing is installed, so `ok` alone would send a
  // user with no engine to `visp-kit init` and a command-not-found.
  return resolution.ok && resolution.found;
}

export async function kitUnavailableGuidance(input: {
  readonly projectPath: string;
  readonly reasonCode?: string;
  readonly reason?: string;
}): Promise<KitGuidance> {
  const detail = input.reason === undefined ? "" : ` (${input.reason})`;

  switch (input.reasonCode) {
    case "no_kit_signals":
    case "status_uninitialized": {
      // Uninitialised is only actionable if the engine is actually installed.
      const reachable = await kitBinaryReachable(input.projectPath);
      return reachable
        ? {
            nextCommand: "visp-kit init .",
            message: [
              "Visp Kit is installed, but this project is not initialised.",
              "Run: visp-kit init ."
            ].join("\n")
          }
        : {
            nextCommand: "visp setup",
            message: [
              "Visp Kit is not installed, so this project cannot be initialised yet.",
              "Run: visp setup",
              "Or install it directly: npm install -g visp-kit"
            ].join("\n")
          };
    }
    case "binary_not_found":
      return {
        nextCommand: "visp setup",
        message: [
          "The visp-kit command was not found on PATH, so Visp Kit cannot run.",
          "Run: visp setup",
          "Or install it directly: npm install -g visp-kit"
        ].join("\n")
      };
    case "status_timeout":
      return {
        nextCommand: "visp-kit status .",
        message: `Visp Kit did not respond in time${detail}. Run: visp-kit status . to see what it reports.`
      };
    default:
      return {
        nextCommand: "visp-kit status .",
        message: [
          `Visp Kit is installed but is not answering correctly${detail}.`,
          "Run: visp-kit status . to see what it reports, then visp doctor."
        ].join("\n")
      };
  }
}
