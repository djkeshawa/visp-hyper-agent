import type { z } from "zod";

/**
 * Read-side parse for a JSON-backed store that must DEGRADE, NEVER CRASH.
 *
 * - a missing file (`raw === undefined`) resolves to the empty/default value
 *   with no warning;
 * - unparseable JSON resolves to the empty/default value plus one warning;
 * - a schema mismatch resolves to the empty/default value plus one warning.
 *
 * `fallback` is the human phrase appended to each warning (e.g. "an empty
 * store", "the default configuration") so callers can surface a precise,
 * store-specific message. The neutral `value` key lets each caller re-wrap the
 * result under its own public field name without changing its API shape.
 *
 * The generic is bound to the schema (not its output) so the returned value is
 * the schema's parsed *output* type — matching what `schema.parse()` would
 * yield — rather than its (more optional) input type.
 */
export function parseJsonStore<S extends z.ZodTypeAny>(
  raw: string | undefined,
  schema: S,
  empty: () => z.infer<S>,
  label: string,
  fallback: string
): { value: z.infer<S>; warnings: string[] } {
  if (raw === undefined) {
    return { value: empty(), warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      value: empty(),
      warnings: [`${label} could not be parsed as JSON; starting from ${fallback}.`]
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return {
      value: empty(),
      warnings: [`${label} did not match the expected schema; starting from ${fallback}.`]
    };
  }

  return { value: result.data, warnings: [] };
}
