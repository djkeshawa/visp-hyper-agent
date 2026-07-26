import { runCli } from "./cli/index.js";

/**
 * Last-resort error boundary. Every command is expected to degrade rather than
 * throw, but if one ever does, the consumer of this stdout is a coding agent
 * parsing delimited `BEGIN_VISP_*` blocks — a raw Node stack trace is the one
 * output shape it cannot interpret, and it reads as "the tool is broken" rather
 * than "this step did not produce a verdict". Emit a block it can parse, put
 * the diagnostic detail on stderr, and exit non-zero so scripts and git hooks
 * still fail closed.
 */
try {
  await runCli(process.argv);
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n]+/gu, " ")
    .trim();
  console.log(
    [
      "BEGIN_VISP_INTERNAL_ERROR",
      "status: INCONCLUSIVE",
      "reason_code: hyper_internal_error",
      `reason: ${message}`,
      "instruction: Re-run the command; if it persists, report this with the stderr stack trace.",
      "END_VISP_INTERNAL_ERROR"
    ].join("\n")
  );
  if (error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exitCode = 1;
}
