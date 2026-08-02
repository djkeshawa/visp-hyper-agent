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

async function kitAvailable(projectPath: string): Promise<string | null> {
  const availability = await detectVisp(projectPath);
  if (availability.state === "healthy") return null;
  return `Visp Kit is not available here (${availability.state}). Run visp setup, or visp-kit init for a new project.`;
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
      return { kind: "blocked", detail: `${next.nextCommand} reported failure. Run it directly for detail.` };
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
      const created = await bridge.runMechanicalCommand(`visp-kit feature ${JSON.stringify(goal)}`);
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
          next.implementationAllowed ? "the task is ready to implement — run visp work" : null,
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
          next.implementationAllowed ? "implementation is allowed — run visp work" : null,
        log: (line) => console.log(line)
      });
      reportStop(stop, "plan");
    });
}

export function handoffVerbCommand(): Command {
  return new Command("handoff")
    .description("Assemble the evidence for review: verify, review, assurance — as far as Kit allows.")
    .option("--task <task-id>", "Task to hand off.")
    .action(async (options: { task?: string }, command: Command) => {
      const projectPath = resolveProjectPath(command);
      const unavailable = await kitAvailable(projectPath);
      if (unavailable !== null) {
        console.error(unavailable);
        process.exitCode = 1;
        return;
      }
      const bridge = new KitCommandBridge({ projectPath });
      void options;
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
      console.log(`verify: ${verify.success ? "passed" : "FAILED"}`);
      const review = await bridge.checkReview(options.task);
      if (review === null) {
        console.error(bridge.warnings.at(-1) ?? "Review did not produce a readable summary.");
        process.exitCode = 1;
        return;
      }
      console.log(`review: ${review.success ? "passed" : "FAILED"}`);
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
