/**
 * Turning a parsed artifact into the labelled values and commands a screen
 * shows.
 *
 * Each projection names the fields it will surface. Anything the artifact also
 * happens to contain is not displayed — the screen shows what the Cockpit
 * promised to show, not whatever the file grew.
 */

import type { CockpitArtifactCommand, CockpitArtifactPath, CockpitArtifactValue, NonEmptyReadonlyArray } from "../contracts.js";
import { isRecord } from "../../core/guards.js";
import type { Projection, ValueField } from "./types.js";

export function projectRecord(
  value: unknown,
  sourcePath: CockpitArtifactPath,
  fields: readonly ValueField[],
  commands: readonly CockpitArtifactCommand[] = []
): Projection {
  const record = asRecord(value);
  const values = fields.flatMap(([key, label]) => {
    if (!(key in record) || record[key] === undefined) return [];
    return [artifactValue(label, scalarFrom(record[key]), sourcePath)];
  });
  if (values.length === 0) throw new TypeError("Artifact projection contains no display values.");
  return Object.freeze({
    values: Object.freeze(values) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([...commands])
  });
}

export function projectWholeArtifact(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  return Object.freeze({
    values: Object.freeze([
      artifactValue("Artifact", scalarFrom(value), sourcePath)
    ]) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([])
  });
}

export function projectText(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Text artifact projection requires nonempty text.");
  }
  return Object.freeze({
    values: Object.freeze([
      artifactValue("Content", value, sourcePath)
    ]) as NonEmptyReadonlyArray<CockpitArtifactValue>,
    commands: Object.freeze([])
  });
}

export function projectProfile(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  return projectRecord(
    value,
    sourcePath,
    [
      ["name", "Name"],
      ["packageManager", "Package manager"],
      ["languages", "Languages"],
      ["frameworks", "Frameworks"],
      ["testFrameworks", "Test frameworks"],
      ["sourceRoots", "Source roots"],
      ["testRoots", "Test roots"]
    ],
    commandArrays(record, sourcePath, [
      ["buildCommands", "Build command"],
      ["testCommands", "Test command"],
      ["lintCommands", "Lint command"],
      ["typecheckCommands", "Typecheck command"]
    ])
  );
}

export function projectWorkflow(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  if (Array.isArray(record.stages)) {
    for (const stage of record.stages) {
      if (!isRecord(stage)) continue;
      const name = typeof stage.name === "string" ? stage.name : "Workflow stage";
      pushCommand(commands, `${name} command`, stage.command, sourcePath);
      pushCommand(commands, `${name} next command`, stage.nextCommand, sourcePath);
    }
  }
  return projectRecord(
    value,
    sourcePath,
    [
      ["version", "Version"],
      ["generatedAt", "Generated at"],
      ["stages", "Stages"],
      ["principles", "Principles"]
    ],
    commands
  );
}

export function projectTaskGraph(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  if (Array.isArray(record.tasks)) {
    for (const task of record.tasks) {
      if (!isRecord(task) || !Array.isArray(task.validationCommands)) continue;
      const taskId = typeof task.id === "string" ? task.id : "Task";
      for (const command of task.validationCommands) {
        pushCommand(commands, `${taskId} validation command`, command, sourcePath);
      }
    }
  }
  return projectRecord(
    value,
    sourcePath,
    [
      ["featureId", "Feature ID"],
      ["featureSlug", "Feature slug"],
      ["status", "Stored status"],
      ["tasks", "Tasks"],
      ["updatedAt", "Updated at"]
    ],
    commands
  );
}

export function projectVerification(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Verification next command", record.nextCommand, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["id", "Report ID"],
      ["taskId", "Task ID"],
      ["mode", "Mode"],
      ["success", "Stored success"],
      ["summary", "Summary"],
      ["scopeValidation", "Scope validation"],
      ["warnings", "Warnings"],
      ["errors", "Errors"],
      ["nextCommand", "Next command"]
    ],
    commands
  );
}

export function projectReview(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Review next command", record.nextCommand, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["id", "Report ID"],
      ["taskId", "Task ID"],
      ["mode", "Mode"],
      ["success", "Stored success"],
      ["result", "Stored result"],
      ["findings", "Findings"],
      ["warnings", "Warnings"],
      ["errors", "Errors"],
      ["nextCommand", "Next command"]
    ],
    commands
  );
}

export function projectAssurance(value: unknown, sourcePath: CockpitArtifactPath): Projection {
  const record = asRecord(value);
  const nextAction = isRecord(record.nextAction) ? record.nextAction : undefined;
  const commands: CockpitArtifactCommand[] = [];
  pushCommand(commands, "Assurance next action", nextAction?.command, sourcePath);
  return projectRecord(
    value,
    sourcePath,
    [
      ["taskId", "Task ID"],
      ["assuranceProfile", "Assurance profile"],
      ["claims", "Claims"],
      ["unresolvedItems", "Unresolved items"],
      ["verdict", "Stored verdict"],
      ["nextAction", "Next action"],
      ["caseHash", "Case hash"]
    ],
    commands
  );
}

export function commandArrays(
  record: Record<string, unknown>,
  sourcePath: CockpitArtifactPath,
  fields: readonly ValueField[]
): readonly CockpitArtifactCommand[] {
  const commands: CockpitArtifactCommand[] = [];
  for (const [key, label] of fields) {
    if (!Array.isArray(record[key])) continue;
    for (const command of record[key]) pushCommand(commands, label, command, sourcePath);
  }
  return commands;
}

export function pushCommand(
  commands: CockpitArtifactCommand[],
  label: string,
  command: unknown,
  sourcePath: CockpitArtifactPath
): void {
  if (typeof command !== "string" || command.trim().length === 0) return;
  commands.push(Object.freeze({ label, command, sourcePath }));
}

export function artifactValue(
  label: string,
  value: CockpitArtifactValue["value"],
  sourcePath: CockpitArtifactPath
): CockpitArtifactValue {
  return Object.freeze({ label, value, sourcePath });
}

export function scalarFrom(value: unknown): CockpitArtifactValue["value"] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Artifact value cannot be represented.");
  return serialized;
}

export function recordString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Artifact value must be an object.");
  return value;
}
