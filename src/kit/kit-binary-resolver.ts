// P10-US-03: Kit binary resolution for the bridge release.
//
// During the rename transition the Kit CLI may be installed as `visp-kit`
// (renamed Kit 0.4+) or `visp` (pre-rename Kit). Resolution order:
//
//   1. `VISP_KIT_BINARY` environment override — explicit user intent wins.
//   2. The `kitBinary` field in `.visp/hyper/config.json`.
//   3. Probe `visp-kit`, then fall back to `visp`.
//
// The fallback carries a trap: once `visp` is Hyper's own binary (final
// dispatcher release), an installed Hyper that spawns `visp` spawns *itself*,
// which used to surface as a schema-parse warning instead of a clean failure.
// The guard below resolves the candidate on PATH and refuses it when its real
// path lives inside a `visp-hyper-agent` package — a clean, named failure.

import { readFile, realpath, access, constants } from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";

export type KitBinaryResolution =
  | {
      readonly ok: true;
      readonly binary: string;
      readonly source: "env" | "config" | "probe" | "fallback";
    }
  | {
      readonly ok: false;
      readonly reasonCode: "self_invocation";
      readonly reason: string;
    };

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Locate a bare command on PATH (POSIX semantics; win32 defers to PATHEXT resolution elsewhere). */
async function locateOnPath(command: string): Promise<string | null> {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return (await isExecutableFile(command)) ? command : null;
  }
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (await isExecutableFile(candidate)) return candidate;
    if (process.platform === "win32") {
      for (const ext of [".cmd", ".exe", ".bat"]) {
        const winCandidate = candidate + ext;
        if (await isExecutableFile(winCandidate)) return winCandidate;
      }
    }
  }
  return null;
}

/**
 * True when the command on PATH resolves into a visp-hyper-agent package —
 * i.e. spawning it would spawn Hyper itself, not Kit.
 */
export async function isSelfInvocation(command: string): Promise<boolean> {
  const located = await locateOnPath(command);
  if (located === null) return false;
  let real: string;
  try {
    real = await realpath(located);
  } catch {
    return false;
  }
  return real.split(sep).includes("visp-hyper-agent");
}

/**
 * Tolerant read of the `kitBinary` field from `.visp/hyper/config.json`.
 * Any missing file, bad JSON or wrong type resolves to undefined — the
 * resolver must never crash a CLI command over configuration.
 */
async function configuredKitBinary(projectPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(projectPath, ".visp", "hyper", "config.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const value = (parsed as { kitBinary?: unknown }).kitBinary;
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  } catch {
    // Fall through: no configuration is a normal state.
  }
  return undefined;
}

export async function resolveKitBinary(options: {
  readonly projectPath?: string;
  readonly configured?: string;
}): Promise<KitBinaryResolution> {
  const selfInvocationFailure = (binary: string): KitBinaryResolution => ({
    ok: false,
    reasonCode: "self_invocation",
    reason:
      `The "${binary}" command resolves to visp-hyper-agent itself, not Visp Kit. ` +
      `Install the visp-kit package (it provides the visp-kit command) or set ` +
      `VISP_KIT_BINARY / the kitBinary config field to the Kit binary.`
  });

  const envOverride = process.env.VISP_KIT_BINARY?.trim();
  if (envOverride !== undefined && envOverride.length > 0) {
    if (await isSelfInvocation(envOverride)) return selfInvocationFailure(envOverride);
    return { ok: true, binary: envOverride, source: "env" };
  }

  const configured =
    options.configured?.trim() ??
    (options.projectPath === undefined
      ? undefined
      : await configuredKitBinary(options.projectPath));
  if (configured !== undefined && configured.length > 0) {
    if (await isSelfInvocation(configured)) return selfInvocationFailure(configured);
    return { ok: true, binary: configured, source: "config" };
  }

  if ((await locateOnPath("visp-kit")) !== null) {
    return { ok: true, binary: "visp-kit", source: "probe" };
  }

  if (await isSelfInvocation("visp")) return selfInvocationFailure("visp");
  return { ok: true, binary: "visp", source: "fallback" };
}
