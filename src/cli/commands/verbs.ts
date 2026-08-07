// P10-US-05: the unified verbs that are not renames of existing commands.
//
// `new`, `plan` and `handoff` are composites and the only genuinely new
// product here. Their loop is driven off Kit's own `next` answer — the
// composite executes whatever bare command Kit recommends, bounded by a
// mechanical-command safety allowlist (see KitCommandBridge.runMechanicalCommand)
// and a verb-scoped stop condition. There is no stage list in this file, and
// there must never be one: Hyper would otherwise acquire a second copy of
// Kit's workflow order. Kit decides; Hyper coordinates and presents.
//
// `check` runs the real checks without moving workflow state (Kit P10-US-02).
// `setup`, `recall` and `learn` refuse visibly until their backing pieces
// (Visp Dev machine adapter — P10-US-08; Memory contract — P10-US-07) answer.

import { Command } from "commander";

import { KitCommandBridge, detectVisp } from "../../kit/kit-command-bridge.js";
import { kitUnavailableGuidance } from "../../kit/kit-guidance.js";
import { resolveProjectPath } from "./shared.js";

/** Kit's next answer reduced to what the composite loop needs. */
function bare(command: string): string {
  return command.replace(/^Run /u, "").replace(/\.$/u, "");
}

type CompositeStop =
  | { readonly kind: "goal-reached"; readonly detail: string }
  | { readonly kind: "human-needed"; readonly detail: string }
  | { readonly kind: "blocked"; readonly detail: string }
  | { readonly kind: "stalled"; readonly detail: string }
  | { readonly kind: "kit-unavailable"; readonly detail: string };

const MAX_COMPOSITE_STEPS = 12;

/** Kit returns 25 errors for a fresh spec; a wall of them is its own failure. */
const MAX_SHOWN_ERRORS = 5;

/**
 * The stop shown when a stage is waiting on the human to fill an artifact in.
 *
 * Three things, because the absence of each was the defect: the reasons
 * verbatim, the file to edit, and which verb resumes. The resume verb is
 * `visp plan` rather than whatever was just run — re-running `visp new` would
 * try to register the feature a second time, while `plan` re-asks Kit what is
 * next and picks up mid-chain.
 */
function composeValidationStop(input: {
  readonly command: string;
  readonly errors: readonly string[];
  readonly featurePath?: string;
}): string {
  const shown = input.errors.slice(0, MAX_SHOWN_ERRORS);
  const hidden = input.errors.length - shown.length;
  const lines = [
    `${input.command} needs more detail before it can pass:`,
    ...shown.map((error) => `  - ${error}`),
    ...(hidden > 0 ? [`  (+${hidden} more)`] : []),
    ...(input.featurePath === undefined ? [] : [`Edit the artifacts in ${input.featurePath},`]),
    `${input.featurePath === undefined ? "Fill them in, " : "then "}re-run visp plan to continue.`
  ];
  return lines.join("\n");
}

/**
 * The preparation chain: commands the composites may still have to execute
 * BEFORE implementation can genuinely start. verify/review/reconcile are
 * deliberately absent — they judge implementation, and Kit's policy gate
 * names them as "next allowed" the moment a context pack exists.
 *
 * This set exists because `implementationAllowed` alone is not a goal. On a
 * two-task feature, finishing T001 leaves implementationAllowed true while
 * Kit's next mechanical step is `context T002`. The goal check used to fire
 * on the flag alone, so `visp plan` said "run visp work" without generating
 * T002's context, `visp work` refused to adopt a task with no context, and
 * status pointed back at plan — a loop with no exit on the thirteen-verb
 * surface, hit live by an evaluation agent eight times in a row.
 */
const PREPARATION_COMMANDS = new Set([
  "init",
  "scan",
  "feature",
  "clarify",
  "spec",
  "plan",
  "tasks",
  "context"
]);

function isPreparationCommand(bareCommand: string): boolean {
  const [binary, subcommand] = bareCommand.trim().split(/\s+/u);
  return (
    (binary === "visp-kit" || binary === "visp") &&
    subcommand !== undefined &&
    PREPARATION_COMMANDS.has(subcommand)
  );
}

async function kitAvailable(projectPath: string): Promise<string | null> {
  const availability = await detectVisp(projectPath);
  if (availability.state === "healthy") return null;
  const guidance = await kitUnavailableGuidance({
    projectPath,
    reasonCode: availability.reasonCode,
    reason: availability.reason
  });
  return guidance.message;
}

/**
 * The next-driven composite loop. Asks Kit what is next; executes it when it
 * is a mechanical preparation command; stops on the verb's goal, on anything
 * that needs a human, on a blocked answer, or when the answer stops changing
 * (a stall is reported honestly, never spun on).
 */
async function askNext(bridge: KitCommandBridge): Promise<{
  readonly nextCommand: string;
  readonly implementationAllowed: boolean;
  readonly prAllowed: boolean;
  readonly success: boolean;
} | null> {
  const next = await bridge.next();
  if (next === null || next.nextCommand === undefined) return null;
  return {
    nextCommand: bare(next.nextCommand),
    implementationAllowed: next.implementationAllowed ?? false,
    prAllowed: next.prAllowed ?? false,
    success: next.success ?? false
  };
}

async function driveByNext(input: {
  readonly bridge: KitCommandBridge;
  readonly isGoal: (next: {
    readonly nextCommand: string;
    readonly implementationAllowed: boolean;
    readonly prAllowed: boolean;
    readonly success: boolean;
  }) => string | null;
  readonly log: (line: string) => void;
}): Promise<CompositeStop> {
  let previousCommand: string | null = null;
  for (let step = 0; step < MAX_COMPOSITE_STEPS; step += 1) {
    const next = await askNext(input.bridge);
    if (next === null) {
      return {
        kind: "kit-unavailable",
        detail: input.bridge.warnings.at(-1) ?? "Kit's next answer was unavailable."
      };
    }
    const goal = input.isGoal(next);
    if (goal !== null) return { kind: "goal-reached", detail: goal };
    if (!next.success) {
      return { kind: "blocked", detail: `Kit reports blocked: ${next.nextCommand}` };
    }
    if (next.nextCommand === previousCommand) {
      return {
        kind: "stalled",
        detail: `Kit keeps answering "${next.nextCommand}" — it needs something this composite cannot supply. Run it yourself, then re-run the verb.`
      };
    }
    previousCommand = next.nextCommand;
    input.log(`→ ${next.nextCommand}`);
    const executed = await input.bridge.runMechanicalCommand(next.nextCommand);
    if (executed === null) {
      return {
        kind: "human-needed",
        detail: `Next step: ${next.nextCommand} — ${input.bridge.warnings.at(-1) ?? "it needs a human."}`
      };
    }
    if (!executed.success) {
      // Two different situations wore the same message here.
      //
      // A Kit stage generates a template, a human fills it in, and the stage is
      // re-validated. So `visp-kit spec` exiting non-zero because its OWN
      // freshly generated draft is still all TBD is the normal path through
      // every stage — not a failure. Reporting it as `blocked` with
      // "Run it directly for detail" threw away the 25 validation errors Kit
      // had just handed over and made the user run a second command to see
      // information the first one already had.
      if (executed.validationErrors.length > 0) {
        return {
          kind: "human-needed",
          detail: composeValidationStop({
            command: next.nextCommand,
            errors: executed.validationErrors,
            featurePath: executed.featurePath
          })
        };
      }
      // No validation errors means this is the hard envelope: the wrong stage,
      // a missing feature, an unreadable artifact. Kit works out a stage-aware
      // repair for those; prefer it over anything invented here.
      return {
        kind: "blocked",
        detail:
          executed.recovery === undefined
            ? `${next.nextCommand} reported failure. Run it directly for detail.`
            : `${next.nextCommand} could not run. Try: ${executed.recovery}`
      };
    }
  }
  return {
    kind: "stalled",
    detail: `Stopped after ${MAX_COMPOSITE_STEPS} steps without reaching the goal — ask visp next what remains.`
  };
}

function reportStop(stop: CompositeStop, verb: string): void {
  const prefix = {
    "goal-reached": "done",
    "human-needed": "waiting on you",
    blocked: "blocked",
    stalled: "stalled",
    "kit-unavailable": "unavailable"
  }[stop.kind];
  console.log(`visp ${verb}: ${prefix} — ${stop.detail}`);
  if (stop.kind === "blocked" || stop.kind === "kit-unavailable") {
    process.exitCode = 1;
  }
}

export function newVerbCommand(): Command {
  return new Command("new")
    .description("Start a piece of work: register the goal with Kit and prepare it as far as Kit allows.")
    .argument("<goal>", "What you want built, in plain words.")
    .action(async (goal: string, _options: unknown, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      const bridge = new KitCommandBridge({ projectPath });
      // The goal is passed as ONE argument. Assembling it into a string here and
      // letting the bridge re-split on whitespace shredded every multi-word goal.
      const created = await bridge.runMechanicalArgv("feature", [goal]);
      if (created === null || !created.success) {
        console.error(
          bridge.warnings.at(-1) ?? "Kit could not register the feature. Run visp-kit feature directly for detail."
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Feature registered: ${goal}`);
      const stop = await driveByNext({
        bridge,
        isGoal: (next) =>
          next.implementationAllowed && !isPreparationCommand(next.nextCommand)
            ? "the task is ready to implement — run visp work"
            : null,
        log: (line) => console.log(line)
      });
      reportStop(stop, "new");
    });
}

export function planVerbCommand(): Command {
  return new Command("plan")
    .description("Drive Kit's preparation for the active feature until implementation is allowed.")
    .action(async (_options: unknown, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      const bridge = new KitCommandBridge({ projectPath });
      const stop = await driveByNext({
        bridge,
        isGoal: (next) =>
          next.implementationAllowed && !isPreparationCommand(next.nextCommand)
            ? "implementation is allowed — run visp work"
            : null,
        log: (line) => console.log(line)
      });
      reportStop(stop, "plan");
    });
}

export function handoffVerbCommand(): Command {
  return new Command("handoff")
    .description("Assemble the evidence for review: verify, review, assurance — as far as Kit allows.")
    // No --task option, deliberately.
    //
    // It used to be declared and then discarded with `void options;`, while the
    // MCP tool went on forwarding it — so a caller could pass a task id, be
    // told nothing, and have it silently ignored. Silently accepting an
    // argument is worse than either honouring or rejecting it.
    //
    // Honouring it is not available: handoff drives whatever Kit's `next`
    // answers, and those answers already carry the task Kit selected. Letting
    // the caller override that here would put task selection in the
    // coordinator, which is exactly the authority split this product forbids —
    // Kit decides, Hyper presents. So the option is gone from both surfaces.
    .action(async (_options: unknown, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      const bridge = new KitCommandBridge({ projectPath });
      const stop = await driveByNext({
        bridge,
        isGoal: (next) =>
          next.prAllowed
            ? "the PR gate is open — the change is ready to hand off"
            : /assurance (?:decision|accept)|review --?accept/u.test(next.nextCommand)
              ? `a human decision is next: ${next.nextCommand}`
              : null,
        log: (line) => console.log(line)
      });
      reportStop(stop, "handoff");
    });
}

/**
 * Print a check's verdict and, when it failed, why.
 *
 * `visp check` used to print `verify: FAILED` and stop — no reason at all,
 * while holding a summary that already listed them. On a real project the
 * withheld reason was a genuine out-of-scope violation naming the offending
 * files, and the user had to run `visp-kit verify --task <id>` to see it.
 * Same defect as the composites, different code path.
 */
function reportCheck(
  label: string,
  summary: {
    readonly success: boolean;
    readonly errors?: readonly string[];
    readonly findings?: readonly {
      readonly severity?: string;
      readonly title?: string;
      readonly message?: string;
      readonly recommendation?: string;
    }[];
  }
): void {
  console.log(`${label}: ${summary.success ? "passed" : "FAILED"}`);
  if (summary.success) return;

  // A failing review usually reports through findings rather than errors —
  // that gap was the surviving half of this defect: verify printed its
  // reasons, review still said "(review reported no detail)" while its
  // summary carried titled findings.
  const findingLines = (summary.findings ?? [])
    .filter((finding) => finding.severity === "error" || finding.severity === "warning")
    .map((finding) => {
      const text = finding.title ?? finding.message ?? "(untitled finding)";
      return finding.recommendation === undefined ? text : `${text} — ${finding.recommendation}`;
    });
  const reasons = [...(summary.errors ?? []), ...findingLines];
  if (reasons.length === 0) {
    console.log(`  (${label} reported no detail; run visp-kit ${label} for the full report)`);
    return;
  }
  for (const reason of reasons.slice(0, MAX_SHOWN_ERRORS)) {
    console.log(`  - ${reason}`);
  }
  const hidden = reasons.length - Math.min(reasons.length, MAX_SHOWN_ERRORS);
  if (hidden > 0) console.log(`  (+${hidden} more)`);
}

export function checkVerbCommand(): Command {
  return new Command("check")
    .description("Run the real checks and record evidence without changing any workflow state.")
    .option("--task <task-id>", "Task to check.")
    .action(async (options: { task?: string }, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      const bridge = new KitCommandBridge({ projectPath });
      const verify = await bridge.checkVerify(options.task);
      if (verify === null) {
        console.error(bridge.warnings.at(-1) ?? "Verification did not produce a readable summary.");
        process.exitCode = 1;
        return;
      }
      reportCheck("verify", verify);
      const review = await bridge.checkReview(options.task);
      if (review === null) {
        console.error(bridge.warnings.at(-1) ?? "Review did not produce a readable summary.");
        process.exitCode = 1;
        return;
      }
      reportCheck("review", review);
      if (!verify.success || !review.success) process.exitCode = 1;
      console.log("No workflow state was changed. Use visp handoff to record progress.");
    });
}

export function setupVerbCommand(): Command {
  return new Command("setup")
    .description("Install and verify the matched Visp pair and host registration (machine scope).")
    .allowUnknownOption(true)
    .action(async (_options: unknown, command: Command) => {
      const { runSetupVerb } = await import("../machine/machine-scope.js");
      await runSetupVerb(resolveProjectPath(command), command.args);
    });
}

export function recallVerbCommand(): Command {
  return new Command("recall")
    .description("Retrieve relevant memory for the active work (requires visp-memory).")
    .argument("[query...]", "What to look for.")
    .action(async (query: string[], _options: unknown, command: Command) => {
      const { runRecallVerb } = await import("../memory/memory-verbs.js");
      await runRecallVerb(resolveProjectPath(command), query.join(" "));
    });
}

export function learnVerbCommand(): Command {
  return new Command("learn")
    .description("Propose a durable memory through the reviewed lifecycle (requires visp-memory).")
    .argument("<note...>", "What should be remembered.")
    .action(async (note: string[], _options: unknown, command: Command) => {
      const { runLearnVerb } = await import("../memory/memory-verbs.js");
      await runLearnVerb(resolveProjectPath(command), note.join(" "));
    });
}
