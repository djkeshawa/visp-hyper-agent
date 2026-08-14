/**
 * Token-usage plumbing shared by every command that can observe cost.
 *
 * The counts themselves are never inferred here. A host that prints exact
 * usage on each completed turn is the only honest source, so the commands
 * take the numbers as arguments and this module decides what to do with the
 * two cases that follow: usage was reported, or it was not.
 */

/**
 * Parse a CLI-supplied integer. Returns the parsed non-negative integer, or
 * `undefined` (with a warning) for anything that is not a clean integer.
 */
export function parseTokenCount(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw.trim())) {
    console.warn(`warning: --${label} "${raw}" is not a valid integer; ignoring.`);
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

export interface ObservedTokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly model?: string;
}

/**
 * True when the host reported real usage — that is, a positive total.
 *
 * Kit records against the total and refuses `--record-usage` when it is zero,
 * so an all-zero report is not a cost observation. Routing it to the recorded
 * branch anyway would send a write Kit rejects, and the task would close with
 * neither a real row nor a deliberate absence. A zero on one side is fine as
 * long as the other side carries usage.
 */
export function hasObservedTokens(usage: ObservedTokenUsage): boolean {
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) > 0;
}

/**
 * The note recorded on a budget row when usage genuinely was not reported.
 *
 * This has to stay literally true. It previously claimed "the coordinator
 * cannot observe the agent's token usage", which was false twice over: Kit
 * ships a working recorder, and most hosts print exact usage every turn. The
 * only true statement is that nothing was handed to this invocation — so the
 * note says that, and names the flags that fix it. A later recorded row for
 * the same task supersedes this one, so the repair heals history.
 */
export function unreportedUsageNote(command: string, taskId: string): string {
  return (
    `${command}: no usable token usage reached this invocation ` +
    `(none was passed, or the reported counts summed to zero); ` +
    `rerun with --input-tokens/--output-tokens from the host's reported counts ` +
    `(e.g. ${command} --task ${taskId} --input-tokens N --output-tokens M) to supersede this row`
  );
}

/** The note recorded on a budget row built from counts the host reported. */
export function reportedUsageNote(command: string): string {
  return `${command}: token usage as reported by the agent host`;
}

/**
 * The warning printed when a task closes without usage. An absent cost meter
 * must be loud: a silent "unavailable" row is what let 38 of them accumulate
 * while the ledger looked merely empty.
 */
export function unreportedUsageWarning(command: string, taskId: string): string {
  return (
    `warning: no token usage was reported for ${taskId}; the cost ledger records it as ` +
    `deliberately unavailable. Pass --input-tokens/--output-tokens to ${command} to record ` +
    `the real cost — a recorded row supersedes this one.`
  );
}
