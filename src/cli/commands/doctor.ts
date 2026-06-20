import { join } from "node:path";
import { Command, Option } from "commander";
import { fileExists, readTextIfExists, vispPath } from "../../core/fs-utils.js";
import { detectVisp, hasKitArtifacts, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { contextPackPathIfExists, resolveProjectPath } from "./shared.js";

type DoctorStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  recovery?: string;
};

type DoctorSummary = {
  success: boolean;
  projectPath: string;
  checks: DoctorCheck[];
  nextCommand: string;
};

const GIT_HOOK_MARKER = "# visp-hyper-guard hook";

export function doctorCommand(): Command {
  return new Command("doctor")
    .description("Check whether Visp Hyper can drive the local Visp Kit workflow.")
    .addOption(new Option("--json", "Print a machine-readable summary."))
    .action(async function (this: Command, options: { json?: boolean }) {
      const projectPath = resolveProjectPath(this);
      const summary = await runDoctor(projectPath);

      if (options.json) {
        console.log(`${JSON.stringify(summary, null, 2)}`);
      } else {
        console.log(formatDoctorSummary(summary));
      }

      if (!summary.success) {
        process.exitCode = 1;
      }
    });
}

export async function runDoctor(projectPath: string): Promise<DoctorSummary> {
  const checks: DoctorCheck[] = [];

  checks.push(await checkHyperInitialized(projectPath));

  const kitArtifactsPresent = await hasKitArtifacts(projectPath);
  checks.push({
    id: "kit-artifacts",
    label: "Visp Kit artifacts",
    status: kitArtifactsPresent ? "pass" : "warn",
    detail: kitArtifactsPresent
      ? "Found .visp/policy.json or .visp/project.json."
      : "No Kit-owned artifacts found; Hyper will use quick/local mode instead of the strict Kit backend.",
    recovery: kitArtifactsPresent ? undefined : "Run `visp init` or `visp agent bootstrap <tool>` in this project."
  });

  if (kitArtifactsPresent) {
    await checkKitBackend(projectPath, checks);
  }

  checks.push(await checkGitHook(projectPath));

  return {
    success: checks.every((check) => check.status !== "fail"),
    projectPath,
    checks,
    nextCommand: nextCommand(checks)
  };
}

async function checkHyperInitialized(projectPath: string): Promise<DoctorCheck> {
  const configPath = vispPath(projectPath, "hyper", "config.json");
  const statePath = vispPath(projectPath, "hyper", "state.json");
  const [configExists, stateExists] = await Promise.all([fileExists(configPath), fileExists(statePath)]);
  if (configExists && stateExists) {
    return {
      id: "hyper-state",
      label: "Visp Hyper state",
      status: "pass",
      detail: "Found .visp/hyper/config.json and .visp/hyper/state.json."
    };
  }
  return {
    id: "hyper-state",
    label: "Visp Hyper state",
    status: "fail",
    detail: "Visp Hyper has not been initialized in this project.",
    recovery: "Run `visp-hyper init --tool <tool>`."
  };
}

async function checkKitBackend(projectPath: string, checks: DoctorCheck[]): Promise<void> {
  const availability = await detectVisp(projectPath);
  if (!availability.available) {
    checks.push({
      id: "kit-binary",
      label: "Visp Kit CLI",
      status: "fail",
      detail: availability.reason,
      recovery: "Install or link the `visp` binary, then run `visp status --json`."
    });
    addWarnings(checks, availability.warnings, "kit-detect-warning");
    return;
  }

  checks.push({
    id: "kit-binary",
    label: "Visp Kit CLI",
    status: "pass",
    detail: `Parsed visp status for ${featureLabel(availability.status.activeFeature) ?? "the project"}.`
  });
  addWarnings(checks, availability.warnings, "kit-detect-warning");

  const bridge = new KitCommandBridge({ projectPath });

  const policy = await bridge.policyValidate();
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-policy-warning");
  checks.push(
    policy === null
      ? {
          id: "kit-policy",
          label: "Policy validation",
          status: "fail",
          detail: "visp policy validate output could not be parsed.",
          recovery: "Run `visp policy validate --json` and fix any invalid policy output."
        }
      : {
          id: "kit-policy",
          label: "Policy validation",
          status: policy.success ? "pass" : "fail",
          detail: policy.success
            ? "Policy validates successfully."
            : `Policy validation failed: ${policy.errors.join("; ") || "no error detail reported"}.`,
          recovery: policy.success ? undefined : "Fix .visp/policy.json, then re-run `visp policy validate`."
        }
  );

  const gate = await bridge.gate("next");
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-gate-warning");
  if (gate === null) {
    checks.push({
      id: "kit-next-gate",
      label: "Next gate",
      status: "fail",
      detail: "visp gate next output could not be parsed.",
      recovery: "Run `visp gate next --json` and inspect the output."
    });
  } else {
    checks.push({
      id: "kit-next-gate",
      label: "Next gate",
      status: gate.allowed ? "pass" : "warn",
      detail: gate.allowed
        ? "The next Kit workflow step is allowed."
        : `The Kit gate is currently blocking progress; next allowed command is ${gate.nextAllowedCommand ?? "visp next"}.`,
      recovery: gate.allowed ? undefined : gate.nextAllowedCommand
    });
  }

  const activeTaskId = availability.status.activeTask?.id;
  if (!activeTaskId) {
    checks.push({
      id: "kit-context-pack",
      label: "Task context pack",
      status: "warn",
      detail: "Kit has no active task yet, so there is no task context pack for Hyper to adopt.",
      recovery: "Advance the Kit workflow until `visp status --json` reports an activeTask."
    });
    return;
  }

  const pack = await bridge.readContextPack(activeTaskId);
  const contextPath = await contextPackPathIfExists(projectPath, activeTaskId);
  addWarnings(checks, drainWarnings(bridge.warnings), "kit-context-warning");
  checks.push({
    id: "kit-context-pack",
    label: "Task context pack",
    status: pack ? "pass" : "warn",
    detail: pack
      ? `Read context for ${activeTaskId}${contextPath ? ` at ${contextPath}` : ""}.`
      : `No readable context pack found for active task ${activeTaskId}.`,
    recovery: pack ? undefined : `Run \`visp context --task ${activeTaskId}\`, then re-run \`visp-hyper doctor\`.`
  });
}

async function checkGitHook(projectPath: string): Promise<DoctorCheck> {
  const gitDir = join(projectPath, ".git");
  if (!(await fileExists(gitDir))) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "warn",
      detail: "No .git directory found; pre-commit scope enforcement is unavailable.",
      recovery: "Initialize Git or run doctor from the repository root."
    };
  }

  const hook = await readTextIfExists(join(gitDir, "hooks", "pre-commit"));
  if (hook?.includes(GIT_HOOK_MARKER)) {
    return {
      id: "git-hook",
      label: "Git scope hook",
      status: "pass",
      detail: "visp-hyper guard is installed as the pre-commit hook."
    };
  }

  return {
    id: "git-hook",
    label: "Git scope hook",
    status: "warn",
    detail: "visp-hyper guard is not installed as the pre-commit hook.",
    recovery: "Run `visp-hyper hooks git`."
  };
}

function drainWarnings(warnings: string[]): string[] {
  const copy = [...warnings];
  warnings.length = 0;
  return copy;
}

function addWarnings(checks: DoctorCheck[], warnings: readonly string[], prefix: string): void {
  for (const [index, warning] of warnings.entries()) {
    checks.push({
      id: `${prefix}-${index + 1}`,
      label: "Bridge warning",
      status: "warn",
      detail: warning
    });
  }
}

function nextCommand(checks: readonly DoctorCheck[]): string {
  const firstAction = checks.find((check) => check.status === "fail" && check.recovery);
  if (firstAction?.recovery) {
    return firstAction.recovery;
  }
  const firstWarning = checks.find((check) => check.status === "warn" && check.recovery);
  return firstWarning?.recovery ?? "visp-hyper run \"<goal>\"";
}

function featureLabel(feature: { id: string; slug?: string } | null | undefined): string | undefined {
  if (!feature) {
    return undefined;
  }
  return feature.slug ? `${feature.id}-${feature.slug}` : feature.id;
}

function formatDoctorSummary(summary: DoctorSummary): string {
  const lines = [
    "VISP_HYPER_DOCTOR",
    `Project: ${summary.projectPath}`,
    `Overall: ${summary.success ? "PASS" : "FAIL"}`,
    ""
  ];

  for (const check of summary.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
    if (check.recovery) {
      lines.push(`  next: ${check.recovery}`);
    }
  }

  lines.push("", `Next command: ${summary.nextCommand}`);
  return lines.join("\n");
}
