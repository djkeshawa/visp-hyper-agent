import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { execFileCrossPlatform } from "../core/exec.js";
import {
  kitBudgetResultSchema,
  kitContextPackSchema,
  kitGateResultSchema,
  kitIntegrationContractSchema,
  kitNextSchema,
  kitReconcileSummarySchema,
  kitReviewSummarySchema,
  kitStatusSchema,
  kitVerifySummarySchema,
  type KitBudgetResult,
  type KitContextPack,
  type KitGateResult,
  type KitIntegrationContract,
  type KitNext,
  type KitReconcileSummary,
  type KitReviewSummary,
  type KitStatus,
  type KitVerifySummary
} from "./kit-schemas.js";

// Schemas with `.transform()` have a different input than output type; allow any input.
type OutputSchema<T> = ZodType<T, ZodTypeDef, unknown>;

const DEFAULT_BINARY = "visp";
const DEFAULT_TIMEOUT_MS = 10_000;

export type KitAvailability =
  | { available: true; status: KitStatus; warnings: string[] }
  | { available: false; reason: string; warnings: string[] };

interface RunResult {
  exitCode: number;
  stdout: string;
}

export type KitContextPackArtifact = {
  pack: KitContextPack;
  path: string;
  sha256: string;
};

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
  const warnings: string[] = [];

  // `visp status` reports initialized=true for ANY .visp/ directory — including
  // the .visp/hyper/ tree visp-hyper's own init creates. Require a kit-owned
  // artifact on disk before trusting the probe at all.
  if (!(await hasKitArtifacts(projectPath))) {
    const reason = "no visp kit artifacts found (.visp/policy.json or .visp/project.json).";
    return { available: false, reason, warnings: [reason] };
  }

  const result = await runCommand(binary, ["status", "--json"], projectPath, timeout, warnings);
  if (!result) {
    return { available: false, reason: warnings[warnings.length - 1] ?? "visp is unavailable.", warnings };
  }

  const status = parseJson(result.stdout, kitStatusSchema);
  if (!status) {
    const reason = "visp status output could not be parsed as kit status JSON.";
    warnings.push(reason);
    return { available: false, reason, warnings };
  }

  if (!status.initialized) {
    const reason = "visp kit is not initialized for this project.";
    warnings.push(reason);
    return { available: false, reason, warnings };
  }

  return { available: true, status, warnings };
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

  async policyValidate(): Promise<{ success: boolean; errors: string[] } | null> {
    const result = await this.run(["policy", "validate"]);
    if (!result) {
      return null;
    }
    const parsed = parseUnknownJson(result.stdout);
    if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
      this.warnings.push("visp policy validate output could not be parsed as JSON.");
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const success = record.success === true;
    const errors = Array.isArray(record.errors)
      ? record.errors.filter((entry): entry is string => typeof entry === "string")
      : [];
    return { success, errors };
  }

  async gate(stage: string, taskId?: string): Promise<KitGateResult | null> {
    const args = taskId ? ["gate", stage, "--task", taskId] : ["gate", stage];
    // Gates legitimately exit non-zero when blocked; treat a parseable body as success.
    return this.invoke(args, kitGateResultSchema, { allowNonZeroExit: true });
  }

  async gateImplement(taskId?: string): Promise<KitGateResult | null> {
    return this.gate("implement", taskId);
  }

  async readContextPack(taskId: string): Promise<KitContextPack | null> {
    return (await this.readContextPackArtifact(taskId))?.pack ?? null;
  }

  async readContextPackArtifact(taskId: string): Promise<KitContextPackArtifact | null> {
    const status = await this.status();
    const candidates = await this.contextPackPaths(taskId, status);
    for (const candidate of candidates) {
      let raw: string;
      try {
        raw = await readFile(candidate, "utf8");
      } catch {
        continue;
      }
      const parsed = parseJson(raw, kitContextPackSchema);
      if (parsed) {
        return {
          pack: parsed,
          path: candidate,
          sha256: hashText(raw)
        };
      }
      this.warnings.push(`Context pack at ${candidate} could not be parsed as JSON.`);
      return null;
    }
    this.warnings.push(`No context pack found for task ${taskId}.`);
    return null;
  }

  async verify(taskId?: string): Promise<KitVerifySummary | null> {
    return this.invoke(withTask(["verify"], taskId), kitVerifySummarySchema);
  }

  async review(taskId?: string): Promise<KitReviewSummary | null> {
    return this.invoke(withTask(["review"], taskId), kitReviewSummarySchema);
  }

  async reconcile(taskId?: string): Promise<KitReconcileSummary | null> {
    return this.invoke(withTask(["reconcile"], taskId), kitReconcileSummarySchema);
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

  async integrationContract(options: { quiet?: boolean } = {}): Promise<KitIntegrationContract | null> {
    const warningStart = this.warnings.length;
    const result = await this.invoke(["integration", "contract"], kitIntegrationContractSchema);
    if (!result && options.quiet) {
      this.warnings.splice(warningStart);
    }
    return result;
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
    options: { allowNonZeroExit?: boolean } = {}
  ): Promise<T | null> {
    const result = await this.run(args);
    if (!result) {
      return null;
    }
    if (result.exitCode !== 0 && !options.allowNonZeroExit) {
      // A non-zero exit may still carry a valid JSON body; only warn if it does not.
      const parsed = parseJson(result.stdout, schema);
      if (parsed) {
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
    return runCommand(this.binary, [...args, "--json"], this.projectPath, this.timeoutMs, this.warnings);
  }

  private async contextPackPaths(taskId: string, status: KitStatus | null): Promise<string[]> {
    const paths: string[] = [];
    const contract = await this.integrationContract({ quiet: true });
    const contractPath = contract?.activeTask?.id === taskId ? contract.artifacts.contextPack : undefined;
    if (contractPath && !contractPath.includes("<")) {
      paths.push(isAbsolute(contractPath) ? contractPath : join(this.projectPath, contractPath));
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
  for (const artifact of ["policy.json", "project.json"]) {
    try {
      await stat(join(projectPath, ".visp", artifact));
      return true;
    } catch {
      // keep probing
    }
  }
  return false;
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
  timeout: number,
  warnings: string[]
): Promise<RunResult | null> {
  try {
    const { stdout } = await execFileCrossPlatform(binary, args, { cwd, timeout });
    return { exitCode: 0, stdout };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; killed?: boolean; signal?: string };

    if (failure.code === "ENOENT") {
      warnings.push(`visp binary "${binary}" was not found.`);
      return null;
    }
    if (failure.killed || failure.signal === "SIGTERM") {
      warnings.push(`visp ${args.join(" ")} timed out after ${timeout}ms.`);
      return null;
    }

    // Non-zero exit: surface stdout so callers can still parse a JSON body.
    if (typeof failure.code === "number") {
      return { exitCode: failure.code, stdout: failure.stdout ?? "" };
    }

    warnings.push(`visp ${args.join(" ")} failed: ${failure.message ?? String(error)}`);
    return null;
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
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
