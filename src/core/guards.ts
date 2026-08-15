/**
 * The narrow type guards every layer needs before it can read an unvalidated
 * value — a parsed artifact, a Kit response, a filesystem error.
 *
 * These were copied into nine modules, and the copies had already drifted:
 * one `isRecord` admitted arrays, which made `value[key]` reads on an array
 * type-check while meaning nothing. One definition removes that class of drift.
 */

/** A plain object. Arrays are excluded: keyed reads on them are never intended. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string carrying at least one non-whitespace character. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** A bare lowercase hex SHA-256 digest, with no `sha256:` prefix. */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** A Node system error carrying the given `errno` code (`"ENOENT"`, …). */
export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
