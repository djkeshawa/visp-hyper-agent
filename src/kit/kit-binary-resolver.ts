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
//
// Locating is delegated to `src/core/executable-resolver.ts`, which owns
// PATHEXT. Nothing here may hand-roll a second copy of that: this resolver's
// own PATH walk once preferred an extensionless `visp-kit` over its sibling
// `visp-kit.cmd`, and reported `found: true` for a file win32 cannot start.

import { readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import { findRunnableCommand } from "../core/executable-resolver.js";

export type KitBinaryResolution =
  | {
      readonly ok: true;
      readonly binary: string;
      readonly source: "env" | "config" | "probe" | "fallback";
      /**
       * Whether this binary was actually LOCATED **and is runnable on this
       * platform**, as opposed to guessed. `source: "fallback"` means visp-kit
       * was not found and `visp` is being assumed — a guess must never be
       * mistaken for evidence that an engine is installed.
       *
       * "Runnable on this platform" is the load-bearing half. A win32 PATH
       * directory routinely holds both an extensionless `visp-kit` (a
       * `#!/bin/sh` script `npm install -g` writes for Git Bash) and a sibling
       * `visp-kit.cmd`; only the second is something `CreateProcess` can start.
       * `found: true` for the first is a claim Hyper cannot honour, so
       * resolution goes through the PATHEXT-aware core resolver rather than an
       * `fs.access(X_OK)` test win32 answers `true` to for every file.
       */
      readonly found: boolean;
    }
  | {
      readonly ok: false;
      readonly reasonCode: "self_invocation";
      readonly reason: string;
    };

/**
 * True when a located path leads into a visp-hyper-agent package — i.e.
 * spawning it would spawn Hyper itself, not Kit.
 */
async function leadsToHyper(located: string | null): Promise<boolean> {
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
 * True when the command resolves into a visp-hyper-agent package.
 *
 * The guard inspects whatever {@link findRunnableCommand} says the host will
 * actually start, so on win32 it reads the PATHEXT match rather than an
 * unrunnable extensionless sibling that happens to share the name.
 */
export async function isSelfInvocation(command: string): Promise<boolean> {
  return await leadsToHyper(await findRunnableCommand(command));
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

  // One PATH walk per candidate: the self-invocation guard and `found` are two
  // questions about the same located file, and asking twice invites them to
  // disagree.
  const resolveNamed = async (
    binary: string,
    source: "env" | "config" | "fallback"
  ): Promise<KitBinaryResolution> => {
    const located = await findRunnableCommand(binary);
    if (await leadsToHyper(located)) return selfInvocationFailure(binary);
    return { ok: true, binary, source, found: located !== null };
  };

  const envOverride = process.env.VISP_KIT_BINARY?.trim();
  if (envOverride !== undefined && envOverride.length > 0) {
    return await resolveNamed(envOverride, "env");
  }

  const configured =
    options.configured?.trim() ??
    (options.projectPath === undefined
      ? undefined
      : await configuredKitBinary(options.projectPath));
  if (configured !== undefined && configured.length > 0) {
    return await resolveNamed(configured, "config");
  }

  // `probe` deliberately does NOT take the self-invocation guard, and
  // `resolveNamed` excludes it from `source` so that stays a decision rather
  // than an omission. The guard asks "does this path lead into a
  // visp-hyper-agent package", and this repository publishes `visp` and
  // `visp-hyper`, never `visp-kit` — so on the probe branch the question can
  // only produce false positives (a Kit checked out under a directory someone
  // named `visp-hyper-agent` would be refused). Extending it is a real
  // question, but a separate one from LC-60.
  if ((await findRunnableCommand("visp-kit")) !== null) {
    return { ok: true, binary: "visp-kit", source: "probe", found: true };
  }

  // Pre-rename Kit provided `visp`, so this remains the right guess — but it is
  // a guess, and `found` says whether anything runnable is actually there.
  return await resolveNamed("visp", "fallback");
}
