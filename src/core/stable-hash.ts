/**
 * Order-independent hashing for the contract fingerprints that Doctor and the
 * MCP tool bridge compare across processes.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * manifests built by different code paths hash differently. Both callers had
 * their own byte-identical copy of this; a fingerprint compared across a
 * process boundary has to be produced by exactly one implementation.
 */

import { createHash } from "node:crypto";

/**
 * Serialize a value with object keys sorted and `undefined` members dropped,
 * so structurally equal values always produce the same string.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The SHA-256 of {@link stableStringify}, as lowercase hex. */
export function hashStable(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
