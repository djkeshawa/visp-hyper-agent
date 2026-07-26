import { Command } from "commander";
import { readState } from "../../core/session-manager.js";
import type {
  RiskFactorCode,
  RiskLevel,
  TaskClass
} from "../../kit/workflow-action-protocol.js";
import { readRoutingState, type RoutingDecision } from "../../routing/routing-state.js";
import { readSkillRegistry } from "../../skills/skill-registry.js";
import { readTelemetry, type TelemetryAttempt } from "../../telemetry/telemetry-store.js";
import { resolveProjectPath } from "./shared.js";

const PRUNE_THRESHOLD = 5;

interface TierBreakdown {
  tier: string;
  attempts: number;
  inconclusive: number;
  firstAttemptPassRate: number | null;
}

interface ClassBreakdown {
  taskClass: TaskClass | null;
  attempts: number;
  inconclusive: number;
  firstAttemptPassRate: number | null;
}

interface RiskLevelBreakdown {
  riskLevel: RiskLevel | null;
  attempts: number;
  inconclusive: number;
  firstAttemptPassRate: number | null;
}

interface RiskFactorBreakdown {
  riskFactor: RiskFactorCode;
  attempts: number;
  inconclusive: number;
  firstAttemptPassRate: number | null;
}

interface ReportAggregate {
  totals: {
    sessions: number;
    tasks: number;
    attempts: number;
    inconclusive: number;
    firstAttemptPassRate: number | null;
  };
  perTier: TierBreakdown[];
  perClass: ClassBreakdown[];
  perRiskLevel: RiskLevelBreakdown[];
  perRiskFactor: RiskFactorBreakdown[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
  };
  quarantines: Array<{ taskClass: TaskClass | null; untilSessionCount: number }>;
  recentDecisions: RoutingDecision[];
  skills: SkillReport[];
}

interface SkillReport {
  name: string;
  usedCount: number;
  lastUsedAt: string | null;
  pruneCandidate: boolean;
}

const RECENT_DECISION_LIMIT = 10;

export function reportCommand(): Command {
  return new Command("report")
    .description("Aggregate telemetry and routing state into a cost/accuracy evidence view.")
    .option("--json", "Print the aggregate report as JSON.")
    .action(async function (this: Command, options: { json?: boolean }) {
      const projectPath = resolveProjectPath(this);
      const aggregate = await buildReport(projectPath);
      if (options.json) {
        console.log(JSON.stringify(aggregate, null, 2));
        return;
      }
      console.log(renderReport(aggregate));
    });
}

async function buildReport(projectPath: string): Promise<ReportAggregate> {
  const state = await readState(projectPath);
  const { data: telemetry } = await readTelemetry(projectPath);
  const { state: routing } = await readRoutingState(projectPath);

  const sessionCount = Object.keys(state.sessions).length;
  const attempts = telemetry.attempts;

  const taskIds = new Set(attempts.map((entry) => entry.workItemKey ?? entry.taskId));

  const tokens = telemetry.usage.reduce(
    (acc, entry) => ({
      inputTokens: acc.inputTokens + (entry.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (entry.outputTokens ?? 0)
    }),
    { inputTokens: 0, outputTokens: 0 }
  );

  const quarantines = routing.quarantines
    .filter((quarantine) => quarantine.untilSessionCount > sessionCount)
    .map((quarantine) => ({
      taskClass: quarantine.taskClass,
      untilSessionCount: quarantine.untilSessionCount
    }));

  const recentDecisions = routing.decisions.slice(-RECENT_DECISION_LIMIT);

  const { registry } = await readSkillRegistry(projectPath);
  const skills = registry.skills.map<SkillReport>((skill) => {
    const reference = skill.lastUsedSessionCount ?? skill.installedAtSessionCount;
    return {
      name: skill.name,
      usedCount: skill.usedCount,
      lastUsedAt: skill.lastUsedAt,
      pruneCandidate: sessionCount - reference >= PRUNE_THRESHOLD
    };
  });

  return {
    totals: {
      sessions: sessionCount,
      tasks: taskIds.size,
      attempts: attempts.length,
      inconclusive: inconclusiveCount(attempts),
      firstAttemptPassRate: firstAttemptPassRate(attempts)
    },
    perTier: groupBy(attempts, (entry) => entry.tier).map(([tier, rows]) => ({
      tier,
      attempts: rows.length,
      inconclusive: inconclusiveCount(rows),
      firstAttemptPassRate: firstAttemptPassRate(rows)
    })),
    perClass: groupBy(attempts, (entry) => entry.taskClass).map(([taskClass, rows]) => ({
      taskClass,
      attempts: rows.length,
      inconclusive: inconclusiveCount(rows),
      firstAttemptPassRate: firstAttemptPassRate(rows)
    })),
    perRiskLevel: groupBy(attempts, (entry) => entry.riskLevel).map(([riskLevel, rows]) => ({
      riskLevel,
      attempts: rows.length,
      inconclusive: inconclusiveCount(rows),
      firstAttemptPassRate: firstAttemptPassRate(rows)
    })),
    perRiskFactor: groupBy(
      attempts.flatMap((attempt) =>
        [...new Set((attempt.riskFactors ?? []).map((factor) => factor.code))]
          .map((riskFactor) => ({ attempt, riskFactor }))
      ),
      (entry) => entry.riskFactor
    ).map(([riskFactor, rows]) => ({
      riskFactor,
      attempts: rows.length,
      inconclusive: inconclusiveCount(rows.map((row) => row.attempt)),
      firstAttemptPassRate: firstAttemptPassRate(rows.map((row) => row.attempt))
    })),
    tokens,
    quarantines,
    recentDecisions,
    skills
  };
}

function inconclusiveCount(attempts: TelemetryAttempt[]): number {
  return attempts.filter((entry) => entry.verdict === "inconclusive").length;
}

/**
 * First-attempt pass rate: the fraction of first-attempt records that passed
 * both verify and review. Returns null when there are no first-attempt records.
 */
function firstAttemptPassRate(attempts: TelemetryAttempt[]): number | null {
  const firstAttempts = attempts.filter(
    (entry) => entry.firstAttempt && entry.verdict !== "inconclusive"
  );
  if (firstAttempts.length === 0) {
    return null;
  }
  const passed = firstAttempts.filter((entry) => entry.verdict === "passed").length;
  return passed / firstAttempts.length;
}

/** Group rows by a key, preserving first-seen key order. */
function groupBy<T, K>(rows: T[], key: (row: T) => K): Array<[K, T[]]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const existing = groups.get(k);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(k, [row]);
    }
  }
  return [...groups.entries()];
}

function formatRate(rate: number | null): string {
  if (rate === null) {
    return "n/a";
  }
  return `${(rate * 100).toFixed(1)}%`;
}

function renderReport(aggregate: ReportAggregate): string {
  const {
    totals,
    perTier,
    perClass,
    perRiskLevel,
    perRiskFactor,
    tokens,
    quarantines,
    recentDecisions,
    skills
  } = aggregate;
  const lines: string[] = [];
  lines.push("BEGIN_VISP_HYPER_REPORT");
  lines.push(`sessions: ${totals.sessions}    tasks: ${totals.tasks}    attempts: ${totals.attempts}`);
  lines.push(`inconclusive_attempts: ${totals.inconclusive}`);
  lines.push(`first_attempt_pass_rate: ${formatRate(totals.firstAttemptPassRate)}`);
  lines.push(`tokens: input=${tokens.inputTokens} output=${tokens.outputTokens}`);
  lines.push("");

  lines.push("per_tier:");
  for (const tier of perTier) {
    lines.push(`  - ${tier.tier}: attempts=${tier.attempts} inconclusive=${tier.inconclusive} pass_rate=${formatRate(tier.firstAttemptPassRate)}`);
  }

  lines.push("per_class:");
  for (const taskClass of perClass) {
    lines.push(`  - ${displayTaskClass(taskClass.taskClass)}: attempts=${taskClass.attempts} inconclusive=${taskClass.inconclusive} pass_rate=${formatRate(taskClass.firstAttemptPassRate)}`);
  }

  lines.push("per_risk_level:");
  for (const riskLevel of perRiskLevel) {
    lines.push(`  - ${riskLevel.riskLevel ?? "unavailable"}: attempts=${riskLevel.attempts} inconclusive=${riskLevel.inconclusive} pass_rate=${formatRate(riskLevel.firstAttemptPassRate)}`);
  }

  lines.push("per_risk_factor:");
  for (const riskFactor of perRiskFactor) {
    lines.push(`  - ${riskFactor.riskFactor}: attempts=${riskFactor.attempts} inconclusive=${riskFactor.inconclusive} pass_rate=${formatRate(riskFactor.firstAttemptPassRate)}`);
  }

  lines.push("quarantines:");
  if (quarantines.length === 0) {
    lines.push("  - none");
  } else {
    for (const quarantine of quarantines) {
      lines.push(`  - ${displayTaskClass(quarantine.taskClass)}: until session ${quarantine.untilSessionCount}`);
    }
  }

  lines.push("recent_routing_decisions:");
  if (recentDecisions.length === 0) {
    lines.push("  - none");
  } else {
    for (const decision of recentDecisions) {
      lines.push(`  - ${decision.taskId} [${displayTaskClass(decision.taskClass)}] -> ${decision.tier}: ${decision.reason}`);
    }
  }

  lines.push("skills:");
  if (skills.length === 0) {
    lines.push("  - none");
  } else {
    for (const skill of skills) {
      const lastUsed = skill.lastUsedAt ?? "never";
      const prune = skill.pruneCandidate ? " [PRUNE CANDIDATE]" : "";
      lines.push(`  - hyper-${skill.name}: used=${skill.usedCount} last_used=${lastUsed}${prune}`);
    }
  }

  if (totals.attempts === 0 && tokens.inputTokens === 0 && tokens.outputTokens === 0) {
    lines.push("note: no telemetry recorded yet.");
  }

  lines.push("END_VISP_HYPER_REPORT");
  return lines.join("\n");
}

function displayTaskClass(taskClass: TaskClass | null): string {
  return taskClass ?? "unclassified";
}
