/**
 * Is there a Visp Kit here, and can it be driven?
 *
 * Two separate questions, deliberately kept apart. `detectVisp` asks whether
 * the CLI runs and answers; `hasKitArtifacts` asks whether this project is
 * actually Kit-owned. `visp status` reports initialized for any .visp/
 * directory — including the one Hyper creates for itself — so the second
 * question cannot be answered from the first.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveKitBinary } from "./kit-binary-resolver.js";
import { classifyKitAvailability } from "./kit-availability.js";
import type { KitAvailability, KitStatusProbeOutcome } from "./kit-availability.js";
import { kitStatusSchema } from "./kit-schemas.js";
import {
  KIT_DEFAULT_TIMEOUT_MS,
  parseJson,
  runCommand
} from "./kit-command-exec.js";

/**
 * Probe whether the external `visp` CLI is installed and the target project has
 * an initialized kit. Never throws — any failure resolves to `available: false`.
 */
export async function detectVisp(
  projectPath: string,
  options: { timeoutMs?: number; binary?: string } = {}
): Promise<KitAvailability> {
  let binary = options.binary;
  if (binary === undefined) {
    const resolution = await resolveKitBinary({ projectPath });
    if (!resolution.ok) {
      return classifyKitAvailability({
        hasKitSignals: true,
        probe: { kind: "failed", reasonCode: "binary_not_found", reason: resolution.reason }
      });
    }
    binary = resolution.binary;
  }
  const timeout = options.timeoutMs ?? KIT_DEFAULT_TIMEOUT_MS;
  const signalProbe = await probeKitArtifacts(projectPath);
  const hasKitSignals = signalProbe.state !== "absent";

  // `visp status` reports initialized=true for ANY .visp/ directory — including
  // the .visp/hyper/ tree visp-hyper's own init creates. Require a kit-owned
  // artifact on disk before trusting the probe at all.
  if (!hasKitSignals) {
    return classifyKitAvailability({ hasKitSignals: false });
  }

  if (signalProbe.state === "unknown") {
    return classifyKitAvailability({
      hasKitSignals: true,
      probe: {
        kind: "failed",
        reasonCode: "kit_signal_probe_failed",
        reason: signalProbe.reason
      }
    });
  }

  const result = await runCommand(binary, ["status", "--json"], projectPath, timeout);
  let probe: KitStatusProbeOutcome;
  if (!result.ok) {
    const reasonCode =
      result.reasonCode === "binary_not_found"
        ? "binary_not_found"
        : result.reasonCode === "command_timeout"
          ? "status_timeout"
          : "status_command_failed";
    probe = { kind: "failed", reasonCode, reason: result.reason };
  } else {
    // Never accept or even parse healthy-looking JSON from a failed command.
    const status =
      result.value.exitCode === 0 ? parseJson(result.value.stdout, kitStatusSchema) : null;
    probe = { kind: "completed", exitCode: result.value.exitCode, status };
  }

  return classifyKitAvailability({ hasKitSignals, probe });
}

/**
 * True when the target project carries a kit-owned artifact on disk. `visp
 * status` reports initialized=true for ANY .visp/ directory (including the
 * .visp/hyper tree visp-hyper creates), so this is the real-kit signal.
 */
export async function hasKitArtifacts(projectPath: string): Promise<boolean> {
  return (await probeKitArtifacts(projectPath)).state !== "absent";
}

export type KitArtifactProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/**
 * Probe durable Kit-owned sentinels without treating Hyper's own `.visp/hyper`,
 * shared `.visp/memory`, or shared `.visp/prompts` trees as Kit authority.
 * Residual feature/config/state artifacts still mean the project is configured;
 * deleting one policy file must not silently enable local fallback.
 */
export async function probeKitArtifacts(projectPath: string): Promise<KitArtifactProbe> {
  const artifacts = [
    "policy.json",
    "project.json",
    "config.json",
    "status.json",
    "overrides.json",
    "workflow.json",
    "budget.json",
    "features",
    "agent",
    "cache",
    "reports",
    "runs",
    "presets",
    "state",
    "hooks"
  ];
  for (const artifact of artifacts) {
    try {
      await stat(join(projectPath, ".visp", artifact));
      return { state: "present" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      return {
        state: "unknown",
        reason: `Could not determine whether Kit signal .visp/${artifact} exists: ${
          error instanceof Error ? error.message : String(error)
        }`
      };
    }
  }
  return { state: "absent" };
}
