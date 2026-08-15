/**
 * Argument validation for the MCP tool table.
 *
 * A tool call arrives as untyped JSON. Every spec states what it needs through
 * these guards, so a bad argument is refused with a message naming the field
 * rather than reaching the CLI as an undefined.
 */



export type ToolArgs = Record<string, unknown>;

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}

/** Require a present string field; returns an error detail or null. */
export function requireString(args: ToolArgs, key: string): string | null {
  if (!(key in args) || !isString(args[key]) || (args[key] as string).length === 0) {
    return `"${key}" must be a non-empty string`;
  }
  return null;
}

/** Validate an optional field with a type guard; returns an error detail or null. */
export function optional(args: ToolArgs, key: string, guard: (v: unknown) => boolean, label: string): string | null {
  if (key in args && args[key] !== undefined && !guard(args[key])) {
    return `"${key}" must be ${label}`;
  }
  return null;
}

export function firstError(...checks: Array<string | null>): string | null {
  return checks.find((check) => check !== null) ?? null;
}
