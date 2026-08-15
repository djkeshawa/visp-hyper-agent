/**
 * Checks over what this project records about itself: the installed version,
 * the Hyper state store, the trusted configuration, context freshness, and the
 * git hook. None of these need Kit or a host binary to answer.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { checkContextFreshness } from "../../../context/context-freshness.js";
import { packageVersion } from "../../../core/package-version.js";
import { fileExists, readTextIfExists, vispPath } from "../../../core/fs-utils.js";
import { hyperConfigSchema, readState, renderDrivenWithoutSession, summarizeCoordination } from "../../../core/session-manager.js";
import type { HyperConfig } from "../../../core/types.js";
import { resolveGitHooksDirectory } from "../../../governance/git-hooks.js";
import { GIT_HOOK_MARKER, renderGitHookContent } from "../hooks.js";
import type { DoctorCheck } from "./types.js";

export function checkPackageVersion(): DoctorCheck {
  const version = packageVersion();
  return {
    id: "hyper-version",
    label: "Visp Hyper version",
    status: version === "0.0.0" ? "warn" : "pass",
    detail: version === "0.0.0"
      ? "Could not resolve package.json version."
      : `Running visp-hyper ${version}.`
  };
}

/**
 * Report what the state store SAYS, not that it exists.
 *
 * This check used to pass on the presence of two files. In the head-to-head
 * evaluation that produced the eighth silent failure, `.visp/hyper/state.json`
 * read exactly `{"activeSessionId": null, "sessions": {}}` after an agent had
 * run `visp setup`, `visp new`, and a full working session — and this check
 * printed `[PASS] Found .visp/hyper/config.json and .visp/hyper/state.json`
 * with an `Overall: PASS` above it. A green tick for a store holding nothing
 * is the same defect this project has now corrected eight times: the artifact
 * that exists to answer "did it do anything" answered by existing.
 *
 * The three outcomes are now distinguishable from the check alone:
 * sessions recorded (pass), nothing recorded and nothing attempted (pass, and
 * it says which), and verbs run with no session to show for them (warn, in
 * full sentences).
 */
export async function checkHyperInitialized(projectPath: string): Promise<DoctorCheck> {
  const configPath = vispPath(projectPath, "hyper", "config.json");
  const statePath = vispPath(projectPath, "hyper", "state.json");
  const [configExists, stateExists] = await Promise.all([fileExists(configPath), fileExists(statePath)]);
  if (!configExists || !stateExists) {
    return {
      id: "hyper-state",
      label: "Visp Hyper state",
      status: "fail",
      detail: "Visp Hyper has not been initialized in this project.",
      recovery: "Run `visp setup`."
    };
  }

  const summary = summarizeCoordination(await readState(projectPath));
  if (summary.drivenWithoutSession) {
    return {
      id: "hyper-state",
      label: "Visp Hyper state",
      status: "warn",
      detail: renderDrivenWithoutSession(summary),
      recovery: "Run `visp work` to adopt Kit's active task, or accept that this work is uncoordinated."
    };
  }
  if (summary.sessionCount === 0) {
    return {
      id: "hyper-state",
      label: "Visp Hyper state",
      status: "pass",
      detail:
        "Initialized, and empty for the honest reason: no work-driving verb has run in this project yet, " +
        "so there is no session and no activity to show. Start with `visp new \"<what you want built>\"`."
    };
  }
  return {
    id: "hyper-state",
    label: "Visp Hyper state",
    status: "pass",
    detail:
      `${summary.sessionCount} session${summary.sessionCount === 1 ? "" : "s"} recorded; ` +
      `${summary.activityCount} work-driving verb${summary.activityCount === 1 ? "" : "s"} in the activity trail.`
  };
}

export async function checkActiveContextFreshness(projectPath: string): Promise<DoctorCheck> {
  const freshness = await checkContextFreshness(projectPath);
  const warnings = freshness.warnings.length > 0
    ? ` Warnings: ${freshness.warnings.join("; ")}`
    : "";

  if (freshness.blocking) {
    return {
      id: "context-freshness",
      label: "Active context freshness",
      status: "fail",
      detail: `${freshness.finding ?? `Context freshness is ${freshness.status}.`}${warnings}`,
      recovery: "Regenerate the handoff with `visp work \"<goal>\"`."
    };
  }

  if (freshness.status === "current") {
    return {
      id: "context-freshness",
      label: "Active context freshness",
      status: freshness.warnings.length > 0 ? "warn" : "pass",
      detail: freshness.warnings.length > 0
        ? `Current context hashes are fresh, but freshness is degraded.${warnings}`
        : "Current context artifact and provenance hashes are fresh."
    };
  }

  return {
    id: "context-freshness",
    label: "Active context freshness",
    status: "warn",
    detail: `${freshness.warnings.join("; ") || "No active context freshness metadata is available."}`
  };
}

export type HyperConfigInspection = {
  config: HyperConfig | null;
  problems: string[];
};

export async function readHyperConfigSnapshot(projectPath: string): Promise<HyperConfigInspection> {
  const raw = await readTextIfExists(vispPath(projectPath, "hyper", "config.json"));
  if (!raw) {
    return { config: null, problems: ["config.json is missing"] };
  }
  try {
    const parsed = hyperConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        config: null,
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.join(".") || "<root>"} ${issue.message}`
        )
      };
    }
    const problems = trustedConfigProblems(parsed.data);
    return { config: parsed.data, problems };
  } catch (error) {
    return {
      config: null,
      problems: [`config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

export function checkTrustedConfig(inspection: HyperConfigInspection): DoctorCheck {
  if (!inspection.config || inspection.problems.length > 0) {
    return {
      id: "hyper-config",
      label: "Trusted project configuration",
      status: "fail",
      detail: inspection.problems.join("; ") || "The Hyper configuration is invalid.",
      recovery: "Review .visp/hyper/config.json and re-run `visp init --force` only if replacing it is intended."
    };
  }
  return {
    id: "hyper-config",
    label: "Trusted project configuration",
    status: "pass",
    detail: `Configuration is valid; default host ${inspection.config.defaultTool}; skill mode ${inspection.config.skillMode}.`
  };
}

function trustedConfigProblems(config: HyperConfig): string[] {
  const requiredBlockedPaths = [".env", "node_modules", ".git"];
  const problems = requiredBlockedPaths
    .filter((path) => !config.blockedPaths.includes(path))
    .map((path) => `blockedPaths must retain ${path}`);
  if (config.validationCommands?.some((command) => command.trim() !== command || command.length === 0)) {
    problems.push("validationCommands must contain non-empty, trimmed commands");
  }
  return problems;
}

export async function checkGitHook(projectPath: string): Promise<DoctorCheck> {
  const hooksDir = await resolveGitHooksDirectory(projectPath);
  if (!hooksDir) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "warn",
      detail: "No .git directory found; pre-commit scope enforcement is unavailable.",
      recovery: "Initialize Git or run doctor from the repository root."
    };
  }

  const hookPath = join(hooksDir, "pre-commit");
  const hook = await readTextIfExists(hookPath);
  if (hook === renderGitHookContent()) {
    const hookStat = await stat(hookPath);
    if (process.platform !== "win32" && (hookStat.mode & 0o111) === 0) {
      return {
        id: "git-hook",
        label: "Git scope hook",
        status: "fail",
        detail: "The visp-hyper pre-commit hook is not executable.",
        recovery: "Run `visp hooks git` to restore the canonical executable hook."
      };
    }
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "pass",
      detail: "The canonical executable visp-hyper guard is installed as the pre-commit hook."
    };
  }

  if (hook?.includes(GIT_HOOK_MARKER)) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "fail",
      detail: "The visp-hyper-owned pre-commit hook was modified and cannot be trusted to enforce scope.",
      recovery: "Run `visp hooks git` to restore the canonical hook."
    };
  }

  return {
    id: "git-hook",
    label: "Git scope hook",
    status: "warn",
    detail: "visp-hyper guard is not installed as the pre-commit hook.",
    recovery: "Run `visp hooks git`."
  };
}
