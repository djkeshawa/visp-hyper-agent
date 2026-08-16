/**
 * Read a field back out of a `VISP_CHECKPOINT_RESULT` block the way a host
 * does — by parsing the emitted text — so an assertion cannot pass against a
 * value the block never actually printed.
 */
export function checkpointBlockField(block: string, field: string): string | undefined {
  const prefix = `${field}: `;
  return block
    .split("\n")
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length);
}
