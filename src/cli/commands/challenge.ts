import { Command, Option } from "commander";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { detectVisp, KitCommandBridge } from "../../kit/kit-command-bridge.js";
import { renderKitAuthorityStop } from "../../kit/kit-availability.js";
import {
  buildChallengerRequest,
  challengerApplicability,
  recordHumanChallengerSubstitution,
  renderChallengerResult,
  renderChallengerResponseResult,
  validateChallengerResponse,
  type ChallengerResponseResult
} from "../../quality/challenger-request.js";
import { resolveProjectPath } from "./shared.js";

const MAX_CHALLENGER_RESPONSE_BYTES = 1_000_000;

export function challengeCommand(): Command {
  return new Command("challenge")
    .description("Build a bounded, read-only challenger request for behavioral or critical Kit work.")
    .addOption(new Option("--json", "Print only the challenger result as JSON."))
    .addOption(
      new Option("--human-reviewer <identifier>", "Record a pending human challenger substitution.")
        .conflicts("response")
    )
    .addOption(
      new Option("--response <path>", "Validate a challenger response JSON file without executing proposals.")
        .conflicts("humanReviewer")
    )
    .addOption(new Option("--note <text>", "Bounded note for the human challenger audit record."))
    .action(async function (
      this: Command,
      options: { json?: boolean; humanReviewer?: string; response?: string; note?: string }
    ) {
      const projectPath = resolveProjectPath(this);
      const kit = await detectVisp(projectPath);
      if (kit.state === "configured-unhealthy") {
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: kit.reasonCode,
            reason: kit.reason
          })
        );
        process.exitCode = 1;
        return;
      }
      if (kit.state === "absent") {
        const result = {
          ok: false as const,
          status: "unavailable" as const,
          reasonCode: "challenger_requires_kit_action",
          reason: "A challenger request requires a canonical Kit action with locked claims."
        };
        console.log(options.json ? JSON.stringify(result) : renderChallengerResult(result));
        process.exitCode = 1;
        return;
      }

      const bridge = new KitCommandBridge({ projectPath });
      const diagnostic = await bridge.nextCanonicalActionDiagnostic("auto");
      if (!diagnostic.ok) {
        for (const warning of bridge.warnings) console.warn(`warning: ${warning}`);
        console.log(
          renderKitAuthorityStop({
            status: "INCONCLUSIVE",
            reasonCode: diagnostic.reasonCode,
            reason: diagnostic.reason
          })
        );
        process.exitCode = 1;
        return;
      }

      // Applicability is checked BEFORE the substitution and response branches,
      // not only inside buildChallengerRequest. Otherwise a routine action that
      // a plain `challenge` correctly reports as `challenger_not_required` could
      // still persist a pending-human-review record or validate a response as
      // ok, producing a challenge artifact for work Kit never required one for.
      const applicability = challengerApplicability(diagnostic.value);
      if (!applicability.ok) {
        const result = {
          ok: false as const,
          status: applicability.status,
          reasonCode: applicability.reasonCode,
          reason: applicability.reason
        };
        console.log(options.json ? JSON.stringify(result, null, 2) : renderChallengerResult(result));
        if (result.status === "unavailable") {
          process.exitCode = 1;
        }
        return;
      }

      if (options.humanReviewer) {
        const record = await recordHumanChallengerSubstitution(
          projectPath,
          diagnostic.value,
          { reviewer: options.humanReviewer, ...(options.note ? { note: options.note } : {}) }
        );
        console.log(
          options.json
            ? JSON.stringify(record, null, 2)
            : [
                "BEGIN_VISP_HUMAN_CHALLENGER_RECORD",
                JSON.stringify(record),
                "END_VISP_HUMAN_CHALLENGER_RECORD"
              ].join("\n")
        );
        return;
      }

      if (options.response) {
        let responseResult: ChallengerResponseResult;
        try {
          const responsePath = await resolveResponsePath(projectPath, options.response);
          const responseStat = await stat(responsePath);
          if (!responseStat.isFile() || responseStat.size > MAX_CHALLENGER_RESPONSE_BYTES) {
            throw new Error(
              `Challenger response must be a regular JSON file no larger than ${MAX_CHALLENGER_RESPONSE_BYTES} bytes.`
            );
          }
          const payload: unknown = JSON.parse(await readFile(responsePath, "utf8"));
          responseResult = validateChallengerResponse(payload, diagnostic.value);
        } catch (error) {
          responseResult = {
            ok: false,
            status: "unverified",
            authority: "non_authoritative",
            reasonCode: "challenger_response_malformed",
            reason: error instanceof Error ? error.message : String(error)
          };
        }
        console.log(
          options.json
            ? JSON.stringify(responseResult, null, 2)
            : renderChallengerResponseResult(responseResult)
        );
        if (!responseResult.ok) {
          process.exitCode = 1;
        }
        return;
      }

      const result = await buildChallengerRequest(projectPath, diagnostic.value);
      console.log(
        options.json
          ? JSON.stringify(result.ok ? result.request : result, null, 2)
          : renderChallengerResult(result)
      );
      if (!result.ok && result.status === "unavailable") {
        process.exitCode = 1;
      }
    });
}

async function resolveResponsePath(projectPath: string, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error("The challenger response path must be project-relative.");
  }
  const projectReal = await realpath(projectPath);
  const candidateReal = await realpath(join(projectPath, path));
  const fromProject = relative(projectReal, candidateReal);
  if (fromProject === ".." || fromProject.startsWith("../") || fromProject.startsWith("..\\") || isAbsolute(fromProject)) {
    throw new Error("The challenger response path must remain inside the project.");
  }
  return candidateReal;
}
