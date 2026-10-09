// LC-179 — the reason visp-memory gave is the one worth showing.
//
// A contract command that fails still answers: it prints a contract-1.0
// failure envelope on stdout and exits non-zero. These pin how that envelope is
// read — accepted only in the contract's shape, and never trusted as raw bytes,
// because stdout is whatever the process on PATH chose to write.

import { describe, expect, it } from "vitest";

import {
  MAX_MEMORY_REASON_CHARS,
  contractFailureReason,
  sanitizeMemoryReason
} from "../../../src/memory/memory-contract-envelope.js";

const envelope = (fields: Record<string, unknown>): string =>
  JSON.stringify({ contractVersion: "1.0", success: false, ...fields });

describe("contractFailureReason", () => {
  it("returns the reason from a contract failure envelope", () => {
    const stdout = `${envelope({ reason: "recall failed: Storage writer conflict" })}\n`;

    expect(contractFailureReason(stdout)).toBe("recall failed: Storage writer conflict");
  });

  it("reads the envelope when it is the last line after other output", () => {
    const stdout = `Loading store...\n${envelope({ reason: "propose failed: locked" })}\n`;

    expect(contractFailureReason(stdout)).toBe("propose failed: locked");
  });

  it("ignores stdout that is not JSON", () => {
    expect(contractFailureReason("Traceback (most recent call last):\n  boom")).toBeUndefined();
    expect(contractFailureReason("")).toBeUndefined();
  });

  it("ignores JSON that is not a failure envelope", () => {
    expect(contractFailureReason(envelope({ success: true, reason: "fine" }))).toBeUndefined();
    expect(contractFailureReason(envelope({}))).toBeUndefined();
    expect(contractFailureReason(envelope({ reason: 42 }))).toBeUndefined();
    expect(
      contractFailureReason(envelope({ contractVersion: "9.9", reason: "other contract" }))
    ).toBeUndefined();
    expect(contractFailureReason(JSON.stringify(["recall failed"]))).toBeUndefined();
  });

  it("ignores an envelope whose reason is empty once cleaned", () => {
    expect(contractFailureReason(envelope({ reason: " \u0007\u001b[0m " }))).toBeUndefined();
  });
});

describe("sanitizeMemoryReason", () => {
  it("removes terminal escape sequences and control characters", () => {
    const hostile = "\u001b[31mrecall\u001b[0m failed:\u0007 bad\u0000 ‮store\r\nnext";

    expect(sanitizeMemoryReason(hostile)).toBe("recall failed: bad store next");
  });

  it("caps an over-long reason and says it was cut", () => {
    const cleaned = sanitizeMemoryReason("x".repeat(MAX_MEMORY_REASON_CHARS * 3));

    expect(cleaned.length).toBe(MAX_MEMORY_REASON_CHARS);
    expect(cleaned.endsWith("…")).toBe(true);
  });

  it("leaves an ordinary reason untouched", () => {
    const reason = "recall failed: set storage.mode: client in .visp-memory.yaml";

    expect(sanitizeMemoryReason(reason)).toBe(reason);
  });
});
