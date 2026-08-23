/**
 * The typed vocabulary Hyper uses to drive Visp Kit.
 *
 * Each method names one Kit command, runs it through the shared execution
 * layer, and validates the reply against its schema. A method returns null (or
 * a diagnostic carrying a reason code) rather than throwing, because Kit being
 * absent, slow, or older than expected is an ordinary state every caller has
 * to render — not an exception.
 *
 * The execution layer lives in `./kit-command-exec.js` and the availability
 * probes in `./kit-detection.js`; both are re-exported here so callers keep a
 * single import surface.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveKitBinary } from "./kit-binary-resolver.js";
import type { KitBinaryResolution } from "./kit-binary-resolver.js";
import { unsupportedIntegrationContractWarning } from "./kit-contract-compat.js";
import { normalizeWorkflowAction } from "./workflow-action-adapter.js";
import type { NormalizedWorkflowAction, WorkflowActionAdapterReasonCode } from "./workflow-action-adapter.js";
import { parseSelectedWorkflowAction, selectWorkflowActionProtocol } from "./workflow-action-protocol.js";
import type { WorkflowActionPreference, WorkflowActionProtocolReasonCode, WorkflowActionProtocolSelection, WorkflowActionWire } from "./workflow-action-protocol.js";
import { kitAuthoritativeContextPackSchema, kitBudgetResultSchema, kitContextPackSchema, kitGateResultSchema, kitIntegrationContractSchema, kitNextSchema, kitPolicyValidationResultSchema, kitReconcileSummarySchema, kitReviewSummarySchema, kitStatusSchema, kitVerifySummarySchema } from "./kit-schemas.js";
import type { KitBudgetResult, KitContextPack, KitGateResult, KitIntegrationContract, KitNext, KitPolicyValidationResult, KitReconcileSummary, KitReviewSummary, KitStatus, KitVerifySummary } from "./kit-schemas.js";
import {
  KIT_DEFAULT_TIMEOUT_MS,
  KIT_LONG_COMMAND_TIMEOUT_MS,
  hashText,
  parseData,
  parseJson,
  parseUnknownJson,
  resolveKitCommandTimeout,
  runCommand,
  tokenizeCommand,
  withTask
} from "./kit-command-exec.js";
import type { CommandFailureCode, OutputSchema, RunResult } from "./kit-command-exec.js";

export type { KitAvailability } from "./kit-availability.js";
export {
  KIT_DEFAULT_TIMEOUT_MS,
  KIT_NO_SPAWN_DEADLINE_MS,
  KIT_LONG_COMMAND_TIMEOUT_MS,
  resolveKitCommandTimeout
} from "./kit-command-exec.js";
export { detectVisp, hasKitArtifacts } from "./kit-detection.js";

export type KitBridgeDiagnosticReasonCode =
  | "integration_contract_unavailable"
  | "unsupported_integration_contract"
  | "strict_next_unavailable"
  | "unsupported_workflow_action"
  // A Kit that never answered inside its budget said nothing about the
  // contract. Folding it into the codes above reported "no supported Kit
  // contract" for a machine that was merely busy, which sends the reader to
  // debug a contract that was never in question (LC-27).
  | "kit_command_timeout"
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
 * What a mechanical Kit command tells us, beyond whether it worked.
 *
 * Kit's `--json` envelope already carries all of this; the bridge used to
 * parse `{ success }` and discard the rest, so the composites could only ever
 * say "reported failure. Run it directly for detail." — sending the user to a
 * second command for information the first one had already handed over. A
 * fresh spec produces 25 validation errors and every one of them was thrown
 * away.
 *
 * Everything past `success` is optional so an older Kit still parses.
 */
const mechanicalResultSchema = z
  .object({
    success: z.boolean(),
    validation: z.object({ errors: z.array(z.string()).default([]) }).optional(),
    // Present on the HARD failure envelope only — a stage-aware repair Kit has
    // already worked out, which beats anything the coordinator could invent.
    recovery: z.string().optional(),
    // The hard envelope's own account of what went wrong. Dropping it forced
    // "Run it directly for detail" on failures Kit had already explained.
    error: z.string().optional(),
    feature: z.object({ path: z.string() }).partial().optional()
  })
  .passthrough();

/**
 * Why the last Kit spawn produced nothing.
 *
 * Most bridge methods answer `null` for every unhappy path, because Kit being
 * absent, slow or older than expected is an ordinary state. That collapses two
 * findings a reader needs to keep apart: a Kit that answered something the
 * contract does not allow, and a Kit that never answered at all. The first is a
 * defect in the pair; the second is a busy machine. This carries the
 * distinction alongside the `null` so a caller — a test above all — can name
 * which one it hit instead of guessing from an absent value (LC-27).
 */
export type KitCommandFailure = Readonly<{
  /** The Kit command as invoked, without the `--json` the bridge always adds. */
  command: string;
  reasonCode: CommandFailureCode;
  reason: string;
  /** The budget that was actually applied to this spawn. */
  timeoutMs: number;
}>;

export type MechanicalCommandResult = {
  readonly success: boolean;
  /** Empty when the command failed for a reason other than validation. */
  readonly validationErrors: readonly string[];
  readonly recovery?: string;
  readonly error?: string;
  readonly featurePath?: string;
};

export class KitCommandBridge {
  readonly warnings: string[] = [];

  private readonly projectPath: string;
  private readonly explicitBinary: string | undefined;
  private binaryResolution: Promise<KitBinaryResolution> | undefined;
  private readonly timeoutMs: number;
  private readonly configuredTimeoutMs: number | undefined;
  private commandFailure: KitCommandFailure | undefined;

  constructor(input: { projectPath: string; binary?: string; timeoutMs?: number }) {
    this.projectPath = input.projectPath;
    this.explicitBinary = input.binary;
    this.timeoutMs = input.timeoutMs ?? KIT_DEFAULT_TIMEOUT_MS;
    this.configuredTimeoutMs = input.timeoutMs;
  }

  /**
   * How the most recent Kit spawn failed, or undefined when it ran — whatever
   * the command then said. Cleared at the start of every spawn.
   *
   * One slot per bridge, so it describes the attempt a caller is holding the
   * result of only while that bridge is driven one command at a time, which is
   * how every caller drives it. Two commands overlapped on one bridge would
   * have the second clear the first's failure; read this after the call whose
   * result you are about to interpret, and give a concurrent caller its own
   * bridge.
   */
  get lastCommandFailure(): KitCommandFailure | undefined {
    return this.commandFailure;
  }

  /**
   * P10-US-03: resolve which Kit binary to spawn — env override, config
   * field, `visp-kit` probe, `visp` fallback — with a self-invocation guard
   * so Hyper never mistakes its own `visp` binary for Kit. Resolved once per
   * bridge and cached; a self-invocation failure is a clean named warning,
   * not a schema-parse surprise.
   */
  private async resolvedBinary(): Promise<string | null> {
    if (this.explicitBinary !== undefined) return this.explicitBinary;
    this.binaryResolution ??= resolveKitBinary({ projectPath: this.projectPath });
    const resolution = await this.binaryResolution;
    if (!resolution.ok) {
      if (!this.warnings.includes(resolution.reason)) {
        this.warnings.push(resolution.reason);
      }
      return null;
    }
    return resolution.binary;
  }

  /** Budget for a Kit command that runs a validation suite rather than reading artifacts. */
  private longTimeout(): number | undefined {
    return resolveKitCommandTimeout({
      configuredMs: this.configuredTimeoutMs,
      longRunning: true
    });
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
      rejectSuccessfulNonZero: true,
      timeoutMs: this.longTimeout()
    });
  }

  async review(taskId?: string): Promise<KitReviewSummary | null> {
    return this.invoke(withTask(["review"], taskId), kitReviewSummarySchema, {
      rejectSuccessfulNonZero: true,
      timeoutMs: this.longTimeout()
    });
  }

  /**
   * P10-US-05 `check`: run the real checks and record evidence without moving
   * workflow state (Kit P10-US-02 flags). Fails unless at least one validation
   * command actually executed — the D-115 zero-command false pass stays closed.
   */
  async checkVerify(taskId?: string): Promise<KitVerifySummary | null> {
    return this.invoke(
      [...withTask(["verify"], taskId), "--no-status-update", "--require-command-evidence"],
      kitVerifySummarySchema,
      { allowNonZeroExit: true, rejectSuccessfulNonZero: true, timeoutMs: this.longTimeout() }
    );
  }

  async checkReview(taskId?: string): Promise<KitReviewSummary | null> {
    return this.invoke(
      [...withTask(["review"], taskId), "--no-status-update"],
      kitReviewSummarySchema,
      { allowNonZeroExit: true, rejectSuccessfulNonZero: true, timeoutMs: this.longTimeout() }
    );
  }

  /**
   * P10-US-05 composites: execute the bare Kit command from Kit's own `next`
   * answer. The allowlist is a safety boundary on unattended execution —
   * mechanical preparation commands only — never an ordering: the order always
   * comes from Kit's answer. Returns null (with a warning) for anything else.
   */
  async runMechanicalCommand(bareCommand: string): Promise<MechanicalCommandResult | null> {
    // Kit's `next` answer is genuinely a string, so it is tokenised here.
    //
    // Naive whitespace splitting was a defect, not a simplification: Kit emits
    // next-commands containing quoted phrases (`visp-kit feature "<describe
    // your feature>"`), and splitting shredded them into separate argv entries
    // carrying literal quote characters. Callers that already HAVE structured
    // arguments should use runMechanicalArgv and skip tokenising entirely.
    const parts = tokenizeCommand(bareCommand);
    const [binary, subcommand, ...rest] = parts;
    if (binary !== "visp" && binary !== "visp-kit") {
      this.warnings.push(`Refusing non-Kit command from next answer: ${bareCommand}`);
      return null;
    }
    if (subcommand === undefined) {
      this.warnings.push(`Refusing malformed command from next answer: ${bareCommand}`);
      return null;
    }
    return this.runMechanicalArgv(subcommand, rest);
  }

  /**
   * Run a mechanical Kit command from arguments that are ALREADY separate.
   *
   * This exists because `visp new "add a login page"` used to be assembled into
   * one string and re-split on whitespace, so Kit received the goal as four
   * argv entries carrying literal quote characters — while Hyper printed the
   * goal back correctly. Every multi-word goal was corrupted, which is to say
   * every real one. Neither package's tests could see it: the damage happened
   * at the process boundary between them.
   *
   * The safety boundary is unchanged and enforced here, so both entry points
   * share exactly one allowlist rather than drifting apart.
   */
  async runMechanicalArgv(
    subcommand: string,
    args: readonly string[]
  ): Promise<MechanicalCommandResult | null> {
    const mechanical = new Set([
      "init",
      "scan",
      "feature",
      "clarify",
      "spec",
      "plan",
      "tasks",
      "context",
      "policy",
      "assurance",
      "reconcile",
      "verify",
      "review",
      // pr assembles the artifacts from evidence that already exists — it is
      // exactly as mechanical as reconcile. Excluding it made the PR itself
      // unreachable from the verbs: handoff declared "the gate is open" and
      // nothing ever wrote pr.md.
      "pr"
    ]);
    if (!mechanical.has(subcommand)) {
      this.warnings.push(
        `Refusing non-mechanical command from next answer: ${subcommand}. A human runs it.`
      );
      return null;
    }
    // Arguments reach execFile as an array, so there is no shell to interpolate
    // into. Metacharacters are still refused: a goal is prose, and one that
    // looks like a command line is a sign something upstream went wrong.
    if (args.some((part) => /[;&|<>`$(){}\\]/u.test(part))) {
      this.warnings.push(`Refusing command with shell metacharacters: ${subcommand} ${args.join(" ")}`);
      return null;
    }
    const result = await this.run([subcommand, ...args], { timeoutMs: this.longTimeout() });
    if (!result) return null;
    const parsed = parseJson(result.stdout, mechanicalResultSchema);
    if (parsed !== null) {
      return {
        success: parsed.success && result.exitCode === 0,
        validationErrors: parsed.validation?.errors ?? [],
        recovery: parsed.recovery,
        error: parsed.error,
        featurePath: parsed.feature?.path
      };
    }
    return { success: result.exitCode === 0, validationErrors: [] };
  }

  async reconcile(
    taskId?: string,
    options: { acceptWarnings?: boolean } = {}
  ): Promise<KitReconcileSummary | null> {
    // --update-task-status is what closes the task when reconciliation
    // passes. Without it, no task ever left "pending" through the visp
    // surface: both live evaluation runs ended with every task still pending
    // after fully PASSED checkpoints, and the next-task selection had nothing
    // to advance past. A reconcile that passes WITH WARNINGS still leaves the
    // task open by Kit's design — accepting those warnings is a human call,
    // carried here as --force only when the caller explicitly made it.
    return this.invoke(
      [
        ...withTask(["reconcile"], taskId),
        "--update-traceability",
        "--update-task-status",
        ...(options.acceptWarnings === true ? ["--force"] : [])
      ],
      kitReconcileSummarySchema,
      { rejectSuccessfulNonZero: true, timeoutMs: this.longTimeout() }
    );
  }

  /**
   * Mark one implementation-checklist item done, with the evidence that backs
   * the attestation. Kit's checklist protocol expects the agent to attest via
   * `visp-kit checklist update` as it works — a command the thirteen-verb
   * surface deliberately does not expose. `visp save --task` is the surface's
   * attestation moment, so it attests the items its own passing checkpoint
   * evidences. Without this, a task driven purely through `visp` verbs ended
   * every checkpoint stuck at VSP020 with five items nothing could mark.
   */
  async attestChecklistItem(input: {
    taskId: string;
    item: string;
    evidence: string;
  }): Promise<{ success: boolean } | null> {
    return this.invoke(
      [
        "checklist",
        "update",
        "--task",
        input.taskId,
        "--item",
        input.item,
        "--status",
        "done",
        "--evidence",
        input.evidence
      ],
      z.object({ success: z.boolean() }).passthrough(),
      { allowNonZeroExit: true }
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
      return this.unavailableDiagnostic(
        "strict_next_unavailable",
        "Kit strict next action is unavailable."
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
      return this.unavailableDiagnostic(
        "integration_contract_unavailable",
        "Kit integration contract is unavailable."
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
    options: {
      allowNonZeroExit?: boolean;
      rejectSuccessfulNonZero?: boolean;
      timeoutMs?: number;
    } = {}
  ): Promise<T | null> {
    const result = await this.run(args, { timeoutMs: options.timeoutMs });
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

  private async run(
    args: string[],
    options: { timeoutMs?: number } = {}
  ): Promise<RunResult | null> {
    // Cleared before the attempt, never after it: a failure recorded by an
    // earlier command must not be read as this one's, and a binary that never
    // resolved is not a spawn failure of this command either.
    this.commandFailure = undefined;
    const binary = await this.resolvedBinary();
    if (binary === null) return null;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const result = await runCommand(binary, [...args, "--json"], this.projectPath, timeoutMs);
    if (!result.ok) {
      this.commandFailure = {
        command: `visp ${args.join(" ")}`,
        reasonCode: result.reasonCode,
        reason: result.reason,
        timeoutMs
      };
      this.warnings.push(result.reason);
      return null;
    }
    return result.value;
  }

  /**
   * Turn "the spawn produced nothing" into a diagnostic that names the real
   * cause. A timeout gets its own reason code; anything else keeps the caller's
   * own vocabulary, since a Kit that answered badly is the caller's concern.
   */
  private unavailableDiagnostic(
    fallbackReasonCode: KitBridgeDiagnosticReasonCode,
    fallbackReason: string
  ): KitBridgeDiagnostic<never> {
    const failure = this.commandFailure;
    if (failure?.reasonCode === "command_timeout") {
      return diagnosticFailure("kit_command_timeout", failure.reason);
    }
    return diagnosticFailure(
      fallbackReasonCode,
      failure?.reason ?? this.warnings[this.warnings.length - 1] ?? fallbackReason
    );
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
