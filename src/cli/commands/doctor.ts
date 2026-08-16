/**
 * `visp doctor`: run every health check and report what it found.
 *
 * The checks themselves live in `./doctor/`, grouped by what they interrogate.
 * This file owns only the order they run in and the exit code they add up to.
 */

import { Command, Option } from "commander";
import { packageVersion } from "../../core/package-version.js";
import { hasKitArtifacts } from "../../kit/kit-command-bridge.js";
import { resolveProjectPath } from "./shared.js";
import type { DoctorCheck, DoctorSummary } from "./doctor/types.js";
import { checkKitBackend } from "./doctor/kit-checks.js";
import { checkMcp } from "./doctor/mcp-checks.js";
import {
  checkMemory,
  checkIntelMcpProvider,
  checkSelectedHost,
  checkToolAssets
} from "./doctor/host-checks.js";
import {
  checkActiveContextFreshness,
  checkGitHook,
  checkHyperInitialized,
  checkPackageVersion,
  checkTrustedConfig,
  readHyperConfigSnapshot
} from "./doctor/project-checks.js";
import { setupRoute } from "./doctor/setup-route.js";
import { formatDoctorSummary, nextCommand } from "./doctor/summary.js";

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
  const configInspection = await readHyperConfigSnapshot(projectPath);
  const config = configInspection.config;

  // Resolved once, because it probes the machine rather than the project and
  // every check that recommends a way forward must recommend the same one.
  const route = await setupRoute();

  checks.push(checkPackageVersion());
  checks.push(await checkHyperInitialized(projectPath, route));
  checks.push(checkTrustedConfig(configInspection));
  checks.push(await checkActiveContextFreshness(projectPath));

  const kitArtifactsPresent = await hasKitArtifacts(projectPath);
  checks.push({
    id: "kit-artifacts",
    label: "Visp Kit artifacts",
    status: kitArtifactsPresent ? "pass" : "warn",
    detail: kitArtifactsPresent
      ? "Found .visp/policy.json or .visp/project.json."
      : "No Kit-owned artifacts found; Hyper will use quick/local mode instead of the strict Kit backend.",
    recovery: kitArtifactsPresent ? undefined : route
  });

  if (kitArtifactsPresent) {
    await checkKitBackend(projectPath, checks);
  }

  checks.push(await checkGitHook(projectPath));
  checks.push(await checkSelectedHost(projectPath, config, route));
  checks.push(await checkToolAssets(projectPath, config, route));
  checks.push(await checkMemory(projectPath, config, route));
  checks.push(await checkIntelMcpProvider(projectPath));
  checks.push(await checkMcp(projectPath));

  return {
    success: checks.every((check) => check.status !== "fail"),
    projectPath,
    version: packageVersion(),
    checks,
    nextCommand: nextCommand(checks)
  };
}
