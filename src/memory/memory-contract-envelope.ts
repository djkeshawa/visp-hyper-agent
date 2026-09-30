// Reading what `visp-memory contract …` printed.
//
// LC-179: a failing contract command still answers — a failure envelope on
// stdout and a non-zero exit — and that envelope carries the cause and, often,
// the remedy. It is also bytes from whatever process answered to the name on
// PATH, so it is accepted only in the contract's shape and cleaned before it
// can reach a terminal.

import { z } from "zod";

export const MEMORY_CONTRACT_VERSION = "1.0";

/** Long enough for a cause and its remedy; short enough not to flood a terminal. */
export const MAX_MEMORY_REASON_CHARS = 500;

const failureEnvelopeSchema = z.object({
  contractVersion: z.literal(MEMORY_CONTRACT_VERSION),
  success: z.literal(false),
  reason: z.string()
});

// CSI and OSC sequences first, so no "[31m" residue survives the control pass.
const TERMINAL_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/gu;
const CONTROL = /\p{Cc}/gu;
// Format characters include the bidi overrides that make text read differently
// from how it is stored.
const FORMAT = /\p{Cf}/gu;

/** Make text from another process safe to print: no escapes, no controls, bounded. */
export function sanitizeMemoryReason(text: string): string {
  const cleaned = text
    .replace(TERMINAL_ESCAPE, "")
    .replace(CONTROL, " ")
    .replace(FORMAT, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cleaned.length <= MAX_MEMORY_REASON_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_MEMORY_REASON_CHARS - 1)}…`;
}

/**
 * The cleaned reason from a contract failure envelope on `stdout`, or
 * `undefined` when stdout holds no such envelope.
 *
 * The envelope is the last thing the command prints, so when the whole of
 * stdout is not one JSON document its last non-empty line is tried.
 */
export function contractFailureReason(stdout: string): string | undefined {
  const lastLine = stdout.trimEnd().split("\n").at(-1) ?? "";
  for (const candidate of [stdout, lastLine]) {
    const parsed = failureEnvelopeSchema.safeParse(parseContractJson(candidate));
    if (!parsed.success) continue;
    const reason = sanitizeMemoryReason(parsed.data.reason);
    return reason.length > 0 ? reason : undefined;
  }
  return undefined;
}

/** Parse contract output, answering `null` for anything that is not JSON. */
export function parseContractJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
