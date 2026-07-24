import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { execFileResolved } from "../core/executable-resolver.js";
import {
  classifyKitAvailability,
  type KitAvailability,
  type KitStatusProbeOutcome
} from "./kit-availability.js";
import { unsupportedIntegrationContractWarning } from "./kit-contract-compat.js";
import {
  normalizeWorkflowAction,
  type NormalizedWorkflowAction,
  type WorkflowActionAdapterReasonCode
} from "./workflow-action-adapter.js";
import {
  parseSelectedWorkflowAction,
  selectWorkflowActionProtocol,
  type WorkflowActionPreference,
  type WorkflowActionProtocolReasonCode,
  type WorkflowActionProtocolSelection,
  type WorkflowActionWire
} from "./workflow-action-protocol.js";
import {
  kitBudgetResultSchema,
  kitAuthoritativeContextPackSchema,
  kitContextPackSchema,
  kitGateResultSchema,
  kitIntegrationContractSchema,
  kitNextSchema,
  kitPolicyValidationResultSchema,
  kitReconcileSummarySchema,
  kitReviewSummarySchema,
  kitStatusSchema,
  kitVerifySummarySchema,
  type KitBudgetResult,
  type KitContextPack,
  type KitGateResult,
  type KitIntegrationContract,
  type KitNext,
  type KitPolicyValidationResult,
  type KitReconcileSummary,
  type KitReviewSummary,
  type KitStatus,
  type KitVerifySummary
} from "./kit-schemas.js";

export type { KitAvailability } from "./kit-availability.js";

// Schemas with `.transform()` have a different input than output type; allow any input.
type OutputSchema<T> = ZodType<T, ZodTypeDef, unknown>;

const DEFAULT_BINARY = "visp";
const DEFAULT_TIMEOUT_MS = 10_000;

interface RunResult {
  exitCode: number;
  stdout: string;
}

type CommandFailureCode = "binary_not_found" | "command_timeout" | "command_failed";

type CommandOutcome =
  | { ok: true; value: RunResult }
  | { ok: false; reasonCode: CommandFailureCode; reason: string };

export type KitBridgeDiagnosticReasonCode =
  | "integration_contract_unavailable"
  | "unsupported_integration_contract"
  | "strict_next_unavailable"
  | "unsupported_workflow_action"
  | Exclude<WorkflowActionProtocolReasonCode, "unsupported_integration_contract" | "unsupported_workflow_action">
  | WorkflowActionAdapterReasonCode;

export type KitBridgeDiagnostic<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reasonCode: KitBridgeDiagnosticReasonCode;
      reason: string;
    };

export type KitContextPackArtifact = {
  pack: KitContextPack;
  path: string;
  sha256: string;
};

export type WorkflowActionProtocolContext = Readonly<{
  contract: KitIntegrationContract;
  selection: WorkflowActionProtocolSelection;
}>;

/**
 * Probe whether the external `visp` CLI is installed and the target project has
 * an initialized kit. Never throws — any failure resolves to `available: false`.
 */
export async function detectVisp(
  projectPath: string,
  options: { timeoutMs?: number; binary?: string } = {}
): Promise<KitAvailability> {
  const binary = options.binary ?? DEFAULT_BINARY;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

export class KitCommandBridge {
  readonly warnings: string[] = [];

  private readonly projectPath: string;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(input: { projectPath: string; binary?: string; timeoutMs?: number }) {
    this.projectPath = input.projectPath;
    this.binary = input.binary ?? DEFAULT_BINARY;
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async status(): Promise<KitStatus | null> {
    return this.invoke(["status"], kitStatusSchema);
  }

  async policyValidate(): Promise<KitPolicyValidationResult | null> {
    const result = await this.run(["policy", "validate"]);
    if (!result) {
      return null;
    }
    const policy = parseJson(result.stdout, kitPolicyValidationResultSchema);
    if (!policy) {
      this.warnings.push("visp policy validate output did not match the expected schema.");
      return null;
    }
    if (policy.success !== policy.validation.passed) {
      this.warnings.push(
        `visp policy validate reported contradictory success=${policy.success} and validation.passed=${policy.validation.passed}.`
      );
      return null;
    }
    if (result.exitCode !== 0 && policy.success) {
      this.warnings.push(
        `visp policy validate exited with code ${result.exitCode} while reporting success=true.`
      );
      return null;
    }
    return policy;
  }

  async gate(stage: string, taskId?: string): Promise<KitGateResult | null> {
    const args = taskId ? ["gate", stage, "--task", taskId] : ["gate", stage];
    const result = await this.run(args);
    if (!result) {
      return null;
    }
    const gate = parseJson(result.stdout, kitGateResultSchema);
    if (!gate) {
      this.warnings.push(`visp ${args.join(" ")} output could not be parsed against the expected schema.`);
      return null;
    }
    if (gate.stage !== stage) {
      this.warnings.push(
        `visp ${args.join(" ")} reported stage=${gate.stage}; expected stage=${stage}.`
      );
      return null;
    }
    if (taskId && gate.taskId !== taskId) {
      this.warnings.push(
        `visp ${args.join(" ")} reported taskId=${gate.taskId ?? "null"}; expected taskId=${taskId}.`
      );
      return null;
    }
    if (gate.success !== gate.allowed) {
      this.warnings.push(
        `visp ${args.join(" ")} reported contradictory success=${gate.success} and allowed=${gate.allowed}.`
      );
      return null;
    }
    // Kit exits non-zero for authoritative blocked gates. It must never pair a
    // failed process with an allowed result.
    if (result.exitCode !== 0 && gate.allowed) {
      this.warnings.push(
        `visp ${args.join(" ")} exited with code ${result.exitCode} while reporting allowed=true.`
      );
      return null;
    }
    return gate;
  }

  async gateImplement(taskId?: string): Promise<KitGateResult | null> {
    return this.gate("implement", taskId);
  }

  async readContextPack(
    taskId: string,
    contract?: KitIntegrationContract
  ): Promise<KitContextPack | null> {
    return (await this.readContextPackArtifact(taskId, contract))?.pack ?? null;
  }

  async readContextPackArtifact(
    taskId: string,
    contract?: KitIntegrationContract
  ): Promise<KitContextPackArtifact | null> {
    return this.readContextPackArtifactWithSchema(taskId, contract, kitContextPackSchema);
  }

  async readAuthoritativeContextPackArtifact(
    taskId: string,
    contract: KitIntegrationContract
  ): Promise<KitContextPackArtifact | null> {
    return this.readContextPackArtifactWithSchema(
      taskId,
      contract,
      kitAuthoritativeContextPackSchema
    );
  }

  private async readContextPackArtifactWithSchema<T extends KitContextPack>(
    taskId: string,
    contract: KitIntegrationContract | undefined,
    schema: OutputSchema<T>
  ): Promise<KitContextPackArtifact | null> {
    const status = contract ? null : await this.status();
    const candidates = await this.contextPackPaths(taskId, status, contract);
    for (const candidate of candidates) {
      let raw: string;
      try {
        raw = await readFile(candidate, "utf8");
      } catch {
        continue;
      }
      const parsed = parseJson(raw, schema);
      if (parsed && parsed.taskId === taskId) {
        return {
          pack: parsed,
          path: candidate,
          sha256: hashText(raw)
        };
      }
      this.warnings.push(
        parsed
          ? `Context pack at ${candidate} reported taskId=${parsed.taskId}; expected ${taskId}.`
          : `Context pack at ${candidate} could not be parsed as JSON.`
      );
      return null;
    }
    this.warnings.push(`No context pack found for task ${taskId}.`);
    return null;
  }

  async verify(taskId?: string): Promise<KitVerifySummary | null> {
    return this.invoke(withTask(["verify"], taskId), kitVerifySummarySchema, {
      rejectSuccessfulNonZero: true
    });
  }

  async review(taskId?: string): Promise<KitReviewSummary | null> {
    return this.invoke(withTask(["review"], taskId), kitReviewSummarySchema, {
      rejectSuccessfulNonZero: true
    });
  }

  async reconcile(taskId?: string): Promise<KitReconcileSummary | null> {
    return this.invoke(
      [...withTask(["reconcile"], taskId), "--update-traceability"],
      kitReconcileSummarySchema,
      { rejectSuccessfulNonZero: true }
    );
  }

  async recordBudget(input: {
    taskId: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    note?: string;
    unavailable?: boolean;
  }): Promise<KitBudgetResult | null> {
    const args = [
      "budget",
      "--task",
      input.taskId,
      input.unavailable ? "--record-usage-unavailable" : "--record-usage"
    ];
    if (input.inputTokens !== undefined) {
      args.push("--input-tokens", String(input.inputTokens));
    }
    if (input.outputTokens !== undefined) {
      args.push("--output-tokens", String(input.outputTokens));
    }
    if (input.model !== undefined) {
      args.push("--model", input.model);
    }
    if (input.note !== undefined) {
      args.push("--usage-note", input.note);
    }
    return this.invoke(args, kitBudgetResultSchema);
  }

  async next(): Promise<KitNext | null> {
    return this.invoke(["next"], kitNextSchema);
  }

  async workflowActionProtocolDiagnostic(
    preference: WorkflowActionPreference = "auto",
    contract?: KitIntegrationContract
  ): Promise<KitBridgeDiagnostic<WorkflowActionProtocolContext>> {
    let currentContract = contract;
    if (currentContract === undefined) {
      const contractResult = await this.integrationContractDiagnostic();
      if (!contractResult.ok) return contractResult;
      currentContract = contractResult.value;
    }
    const selected = selectWorkflowActionProtocol(currentContract, preference);
    if (!selected.ok) {
      this.warnings.push(selected.reason);
      return diagnosticFailure(selected.reasonCode, selected.reason);
    }
    return {
      ok: true,
      value: { contract: currentContract, selection: selected.value }
    };
  }

  async nextCanonicalAction(
    preference: WorkflowActionPreference = "auto"
  ): Promise<NormalizedWorkflowAction | null> {
    const result = await this.nextCanonicalActionDiagnostic(preference);
    return result.ok ? result.value : null;
  }

  async nextCanonicalActionDiagnostic(
    preference: WorkflowActionPreference = "auto",
    contract?: KitIntegrationContract
  ): Promise<KitBridgeDiagnostic<NormalizedWorkflowAction>> {
    const protocol = await this.workflowActionProtocolDiagnostic(preference, contract);
    if (!protocol.ok) return protocol;

    const { selection } = protocol.value;
    const args =
      selection.mode === "legacy_v2"
        ? ["next", "--format", "json"]
        : ["next", "--format", "json", "--protocol", selection.protocolVersion];
    const result = await this.run(args);
    if (!result) {
      return diagnosticFailure(
        "strict_next_unavailable",
        this.warnings[this.warnings.length - 1] ?? "Kit strict next action is unavailable."
      );
    }

    const parsed = parseSelectedWorkflowAction(parseUnknownJson(result.stdout), selection);
    if (!parsed.ok) {
      this.warnings.push(parsed.reason);
      return diagnosticFailure(parsed.reasonCode, parsed.reason);
    }
    if (result.exitCode !== 0 && parsed.value.verdict === "ready") {
      const reason = `visp ${args.join(" ")} exited with code ${result.exitCode} while reporting verdict=ready.`;
      this.warnings.push(reason);
      return diagnosticFailure("workflow_action_contradiction", reason);
    }

    const contradiction = contractActionContradiction(protocol.value.contract, parsed.value);
    if (contradiction !== undefined) {
      this.warnings.push(contradiction);
      return diagnosticFailure("workflow_action_contradiction", contradiction);
    }
    const normalized = normalizeWorkflowAction(parsed.value, selection);
    if (!normalized.ok) {
      this.warnings.push(normalized.reason);
      return diagnosticFailure(normalized.reasonCode, normalized.reason);
    }
    return normalized;
  }

  async integrationContract(options: { quiet?: boolean } = {}): Promise<KitIntegrationContract | null> {
    const warningStart = this.warnings.length;
    const result = await this.integrationContractDiagnostic();
    if (!result.ok && options.quiet) {
      this.warnings.splice(warningStart);
    }
    return result.ok ? result.value : null;
  }

  async integrationContractDiagnostic(): Promise<KitBridgeDiagnostic<KitIntegrationContract>> {
    const args = ["integration", "contract"];
    const result = await this.run(args);
    if (!result) {
      return diagnosticFailure(
        "integration_contract_unavailable",
        this.warnings[this.warnings.length - 1] ?? "Kit integration contract is unavailable."
      );
    }
    if (result.exitCode !== 0) {
      const reason = `visp ${args.join(" ")} exited with code ${result.exitCode}.`;
      this.warnings.push(reason);
      return diagnosticFailure("integration_contract_unavailable", reason);
    }

    const payload = parseUnknownJson(result.stdout);
    const unsupported = unsupportedIntegrationContractWarning(payload);
    if (unsupported) {
      this.warnings.push(unsupported);
      return diagnosticFailure("unsupported_integration_contract", unsupported);
    }
    const contract = payload === undefined ? null : parseData(payload, kitIntegrationContractSchema);
    if (!contract) {
      const reason = `visp ${args.join(" ")} output could not be parsed against the expected schema.`;
      this.warnings.push(reason);
      return diagnosticFailure("integration_contract_unavailable", reason);
    }
    return { ok: true, value: contract };
  }

  /**
   * Install the kit's Claude Code PreToolUse hook via `visp hooks claude`.
   * Returns the parsed `{ success }` flag, or null on spawn/parse failure.
   */
  async hooksClaude(): Promise<{ success: boolean } | null> {
    const result = await this.run(["hooks", "claude"]);
    if (!result) {
      return null;
    }
    const parsed = parseUnknownJson(result.stdout);
    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      this.warnings.push("visp hooks claude output could not be parsed as JSON.");
      return null;
    }
    return { success: (parsed as Record<string, unknown>).success === true };
  }

  private async invoke<T>(
    args: string[],
    schema: OutputSchema<T>,
    options: { allowNonZeroExit?: boolean; rejectSuccessfulNonZero?: boolean } = {}
  ): Promise<T | null> {
    const result = await this.run(args);
    if (!result) {
      return null;
    }
    if (result.exitCode !== 0 && !options.allowNonZeroExit) {
      // A non-zero exit may carry an authoritative failure body. It must never
      // carry a trusted success for checkpoint evidence.
      const parsed = parseJson(result.stdout, schema);
      if (parsed) {
        if (
          options.rejectSuccessfulNonZero &&
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { success?: unknown }).success === true
        ) {
          this.warnings.push(
            `visp ${args.join(" ")} exited with code ${result.exitCode} while reporting success=true.`
          );
          return null;
        }
        return parsed;
      }
      this.warnings.push(`visp ${args.join(" ")} exited with code ${result.exitCode}.`);
      return null;
    }
    const parsed = parseJson(result.stdout, schema);
    if (!parsed) {
      this.warnings.push(`visp ${args.join(" ")} output could not be parsed against the expected schema.`);
      return null;
    }
    return parsed;
  }

  private async run(args: string[]): Promise<RunResult | null> {
    const result = await runCommand(
      this.binary,
      [...args, "--json"],
      this.projectPath,
      this.timeoutMs
    );
    if (!result.ok) {
      this.warnings.push(result.reason);
      return null;
    }
    return result.value;
  }

  private async contextPackPaths(
    taskId: string,
    status: KitStatus | null,
    pinnedContract?: KitIntegrationContract
  ): Promise<string[]> {
    const paths: string[] = [];
    const contract = pinnedContract ?? (await this.integrationContract({ quiet: true }));
    const contractPath = contract?.activeTask?.id === taskId ? contract.artifacts.contextPack : undefined;
    if (contractPath && !contractPath.includes("<")) {
      paths.push(isAbsolute(contractPath) ? contractPath : join(this.projectPath, contractPath));
    }
    if (pinnedContract) {
      return paths;
    }
    const featureRoot = join(this.projectPath, ".visp", "features");
    if (status?.activeFeature) {
      const { id, slug } = status.activeFeature;
      const key = slug ? `${id}-${slug}` : id;
      paths.push(join(featureRoot, key, "context", `${taskId}.context.json`));
    }
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(featureRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = join(featureRoot, entry.name, "context", `${taskId}.context.json`);
        if (!paths.includes(candidate)) {
          paths.push(candidate);
        }
      }
    } catch {
      // Feature directory may not exist; the caller handles the empty result.
    }
    return paths;
  }
}

/**
 * True when the target project carries a kit-owned artifact on disk. `visp
 * status` reports initialized=true for ANY .visp/ directory (including the
 * .visp/hyper tree visp-hyper creates), so this is the real-kit signal.
 */
export async function hasKitArtifacts(projectPath: string): Promise<boolean> {
  return (await probeKitArtifacts(projectPath)).state !== "absent";
}

type KitArtifactProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/**
 * Probe durable Kit-owned sentinels without treating Hyper's own `.visp/hyper`,
 * shared `.visp/memory`, or shared `.visp/prompts` trees as Kit authority.
 * Residual feature/config/state artifacts still mean the project is configured;
 * deleting one policy file must not silently enable local fallback.
 */
async function probeKitArtifacts(projectPath: string): Promise<KitArtifactProbe> {
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

function withTask(args: string[], taskId?: string): string[] {
  // The real CLI takes the task as a flag; a positional id is parsed as a path.
  return taskId ? [...args, "--task", taskId] : args;
}

/**
 * Centralizes ENOENT (binary missing) and timeout handling. Returns null and
 * records a warning for spawn-level failures; returns the captured stdout and
 * exit code otherwise — even when the exit code is non-zero.
 */
async function runCommand(
  binary: string,
  args: string[],
  cwd: string,
  timeout: number
): Promise<CommandOutcome> {
  try {
    const { stdout } = await execFileResolved(binary, args, { cwd, timeout });
    return { ok: true, value: { exitCode: 0, stdout } };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; killed?: boolean; signal?: string };

    if (failure.code === "ENOENT" || failure.code === "EINVAL") {
      return {
        ok: false,
        reasonCode: "binary_not_found",
        reason: `visp binary "${binary}" was not found.`
      };
    }
    if (failure.killed || failure.signal === "SIGTERM") {
      return {
        ok: false,
        reasonCode: "command_timeout",
        reason: `visp ${args.join(" ")} timed out after ${timeout}ms.`
      };
    }

    // Non-zero exit: surface stdout so callers can still parse a JSON body.
    if (typeof failure.code === "number") {
      return {
        ok: true,
        value: { exitCode: failure.code, stdout: failure.stdout ?? "" }
      };
    }

    return {
      ok: false,
      reasonCode: "command_failed",
      reason: `visp ${args.join(" ")} failed: ${failure.message ?? String(error)}`
    };
  }
}

function parseUnknownJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function parseJson<T>(stdout: string, schema: OutputSchema<T>): T | null {
  const data = parseUnknownJson(stdout);
  if (data === undefined) {
    return null;
  }
  return parseData(data, schema);
}

function parseData<T>(data: unknown, schema: OutputSchema<T>): T | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

function contractActionContradiction(
  contract: KitIntegrationContract,
  action: WorkflowActionWire
): string | undefined {
  const contractTaskId = contract.activeTask?.id ?? null;
  const actionTaskId = action.protocolVersion === "2.0" ? action.taskId : action.task?.id ?? null;
  if (contractTaskId !== actionTaskId) {
    return `Kit integration contract active task ${contractTaskId ?? "null"} contradicts WorkflowAction task ${actionTaskId ?? "null"}.`;
  }
  if (action.protocolVersion !== "2.0") {
    const contractFeature = contract.activeFeature;
    const actionFeature = action.feature;
    if (
      (contractFeature === null) !== (actionFeature === null) ||
      (contractFeature !== null &&
        actionFeature !== null &&
        (contractFeature.id !== actionFeature.id || contractFeature.slug !== actionFeature.slug))
    ) {
      return `Kit integration contract active feature contradicts WorkflowAction ${action.protocolVersion} feature identity.`;
    }
  }
  return undefined;
}

function diagnosticFailure(
  reasonCode: KitBridgeDiagnosticReasonCode,
  reason: string
): KitBridgeDiagnostic<never> {
  return { ok: false, reasonCode, reason };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
