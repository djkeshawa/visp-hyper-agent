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

import { recordVerbActivity } from "../../core/session-manager.js";
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
      const cause = executed.error === undefined ? "" : ` ${executed.error}`;
      return {
        kind: "blocked",
        detail:
          executed.recovery === undefined
            ? executed.error === undefined
              ? `${next.nextCommand} reported failure. Run it directly for detail.`
              : `${next.nextCommand} failed:${cause}`
            : `${next.nextCommand} could not run.${cause} Try: ${executed.recovery}`
      };
    }
  }
  return {
    kind: "stalled",
    detail: `Stopped after ${MAX_COMPOSITE_STEPS} steps without reaching the goal — ask visp next what remains.`
  };
}

/**
 * Print the stop AND record it in `.visp/hyper/state.json`.
 *
 * The recording is the fix for the eighth silent failure. These composites are
 * the whole Kit-backed working surface — `new`, `plan`, `handoff` — and not
 * one of them touched Hyper's own store, so a project driven entirely through
 * them ended with a state file byte-identical to a project where Hyper had
 * never been installed. The verb ran; the file has to say so.
 *
 * The write happens after the answer is printed and cannot change the exit
 * code: bookkeeping never costs the user the result they asked for.
 */
async function reportStop(projectPath: string, stop: CompositeStop, verb: string): Promise<void> {
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
  await recordVerbActivity(projectPath, { verb, outcome: stop.kind, detail: stop.detail });
}

/**
 * Tasks that make starting a NEW feature premature. Pure for testability.
 */
export function unfinishedActiveTasks(
  tasks: ReadonlyArray<{ readonly id: string; readonly title: string; readonly status: string }>
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  return tasks.filter((task) => task.status !== "done" && task.status !== "verified");
}

async function activeFeaturePendingTasks(
  projectPath: string
): Promise<{ feature: string; tasks: ReadonlyArray<{ id: string; title: string }> } | null> {
  try {
    const { readTextIfExists } = await import("../../core/fs-utils.js");
    const { join } = await import("node:path");
    const statusText = await readTextIfExists(join(projectPath, ".visp", "status.json"));
    if (!statusText) return null;
    const status = JSON.parse(statusText) as { activeFeaturePath?: string };
    if (typeof status.activeFeaturePath !== "string") return null;
    const graphText = await readTextIfExists(
      join(projectPath, status.activeFeaturePath, "task-graph.json")
    );
    if (!graphText) return null;
    const graph = JSON.parse(graphText) as {
      tasks?: Array<{ id?: string; title?: string; status?: string }>;
    };
    const tasks = unfinishedActiveTasks(
      (graph.tasks ?? []).filter(
        (task): task is { id: string; title: string; status: string } =>
          typeof task.id === "string" &&
          typeof task.title === "string" &&
          typeof task.status === "string"
      )
    );
    if (tasks.length === 0) return null;
    return { feature: status.activeFeaturePath.split("/").at(-1) ?? "the active feature", tasks };
  } catch {
    return null;
  }
}

export function newVerbCommand(): Command {
  return new Command("new")
    .description("Start a piece of work: register the goal with Kit and prepare it as far as Kit allows.")
    .argument("<goal>", "What you want built, in plain words.")
    .option(
      "--switch",
      "Start the new feature even though the active one still has unfinished tasks."
    )
    .action(async (goal: string, options: { switch?: boolean }, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      // Seven evaluation rounds ran; in three of them the agent started the
      // next feature while the current one still had pending tasks, and
      // `new` switched the active pointer without a word — the unfinished
      // work became unreachable from the verbs. Starting fresh mid-feature
      // is a decision, so it takes a flag.
      if (options.switch !== true) {
        const pending = await activeFeaturePendingTasks(projectPath);
        if (pending !== null) {
          console.error(
            [
              `${pending.feature} still has unfinished tasks: ${pending.tasks
                .slice(0, 4)
                .map((task) => `${task.id} (${task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title})`)
                .join(", ")}${pending.tasks.length > 4 ? ` (+${pending.tasks.length - 4} more)` : ""}.`,
              "Finish them (visp plan → visp work → visp save --task <id>), or pass --switch to start a new feature anyway."
            ].join("\n")
          );
          process.exitCode = 1;
          await recordVerbActivity(projectPath, {
            verb: "new",
            outcome: "refused",
            detail: `${pending.feature} still has unfinished tasks`
          });
          return;
        }
      }
      const bridge = new KitCommandBridge({ projectPath });
      // The goal is passed as ONE argument. Assembling it into a string here and
      // letting the bridge re-split on whitespace shredded every multi-word goal.
      const created = await bridge.runMechanicalArgv("feature", [goal]);
      if (created === null || !created.success) {
        const reason =
          bridge.warnings.at(-1) ?? "Kit could not register the feature. Run visp-kit feature directly for detail.";
        console.error(reason);
        process.exitCode = 1;
        await recordVerbActivity(projectPath, { verb: "new", outcome: "blocked", detail: reason });
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
      await reportStop(projectPath, stop, "new");
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
      await reportStop(projectPath, stop, "plan");
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
        // Handoff's job includes the PR itself. Declaring the goal the moment
        // prAllowed turned true left `visp-kit pr` — the step that actually
        // writes pr.md — unreachable from the verbs, and status/next/handoff
        // then repeated "the PR gate is open" forever with nothing to be done.
        // While Kit's next step IS the pr command, keep driving (pr is in the
        // mechanical allowlist); once Kit reports the feature complete, that
        // sentence is the goal.
        isGoal: (next) => {
          if (next.nextCommand.startsWith("Feature complete")) return next.nextCommand;
          if (/assurance (?:decision|accept)|review --?accept/u.test(next.nextCommand)) {
            return `a human decision is next: ${next.nextCommand}`;
          }
          if (next.prAllowed && !/^visp(?:-kit)?\s+pr\b/u.test(next.nextCommand)) {
            return "the PR gate is open — the change is ready to hand off";
          }
          return null;
        },
        log: (line) => console.log(line)
      });
      await reportStop(projectPath, stop, "handoff");
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
  const reasons = [
    ...(summary.errors ?? []),
    ...findingLines,
    ...("error" in summary && typeof summary.error === "string" ? [summary.error] : [])
  ];
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
        const reason = bridge.warnings.at(-1) ?? "Verification did not produce a readable summary.";
        console.error(reason);
        process.exitCode = 1;
        await recordVerbActivity(projectPath, { verb: "check", outcome: "blocked", detail: reason });
        return;
      }
      reportCheck("verify", verify);
      const review = await bridge.checkReview(options.task);
      if (review === null) {
        const reason = bridge.warnings.at(-1) ?? "Review did not produce a readable summary.";
        console.error(reason);
        process.exitCode = 1;
        await recordVerbActivity(projectPath, { verb: "check", outcome: "blocked", detail: reason });
        return;
      }
      reportCheck("review", review);
      const passed = verify.success && review.success;
      if (!passed) process.exitCode = 1;
      console.log("No workflow state was changed. Use visp handoff to record progress.");
      // `check` changes no WORKFLOW state — that promise is Kit's and stands.
      // Recording that Hyper ran it is a different thing: the checks are the
      // most-used verb in a working session, and leaving them out of the
      // activity trail would put the biggest gap back where it was.
      await recordVerbActivity(projectPath, {
        verb: "check",
        outcome: passed ? "goal-reached" : "human-needed",
        detail: passed ? "verify and review passed" : "verify or review reported findings"
      });
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
