import { timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import {
  assertCockpitBindHost,
  assertCockpitHostHeader,
  cockpitSessionTokenMatches,
  COCKPIT_BIND_HOST,
  COCKPIT_SESSION_TOKEN_BYTES,
  expectedCockpitHostHeader,
  generateCockpitSessionToken,
  isValidCockpitHostHeader,
  readCockpitBearerToken
} from "../src/cockpit/security.js";

beforeEach(() => {
  vi.mocked(timingSafeEqual).mockClear();
});

describe("Cockpit loopback and Host security primitives", () => {
  it("accepts only the exact IPv4 loopback bind address", () => {
    expect(COCKPIT_BIND_HOST).toBe("127.0.0.1");
    expect(() => assertCockpitBindHost("127.0.0.1")).not.toThrow();
    for (const host of ["", "localhost", "0.0.0.0", "::", "::1", "127.0.0.2", "127.0.0.1 "]) {
      expect(() => assertCockpitBindHost(host), host).toThrow(/127\.0\.0\.1|exactly/u);
    }
  });

  it("constructs and accepts only the exact loopback Host header for the actual port", () => {
    expect(expectedCockpitHostHeader(1)).toBe("127.0.0.1:1");
    expect(expectedCockpitHostHeader(65_535)).toBe("127.0.0.1:65535");
    expect(isValidCockpitHostHeader("127.0.0.1:43127", 43_127)).toBe(true);
    expect(() => assertCockpitHostHeader("127.0.0.1:43127", 43_127)).not.toThrow();

    for (const header of [
      undefined,
      "127.0.0.1",
      "127.0.0.1:43128",
      "127.0.0.1:43127 ",
      "localhost:43127",
      "[::1]:43127",
      "0.0.0.0:43127",
      "attacker.example:43127",
      "127.0.0.1:43127, attacker.example"
    ]) {
      expect(isValidCockpitHostHeader(header, 43_127), String(header)).toBe(false);
      expect(() => assertCockpitHostHeader(header, 43_127), String(header)).toThrow(/Host/u);
    }
  });

  it.each([0, -1, 1.5, 65_536, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid listener port %s",
    (port) => {
      expect(() => expectedCockpitHostHeader(port)).toThrow(/port|integer/u);
    }
  );
});

describe("Cockpit session credentials", () => {
  it("generates fresh URL-safe tokens with 256 bits of entropy", () => {
    expect(COCKPIT_SESSION_TOKEN_BYTES).toBe(32);
    const tokens = Array.from({ length: 128 }, () => generateCockpitSessionToken());

    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
    }
  });

  it("compares equal-length digests in constant-time for matching and mismatched credentials", () => {
    const expected = generateCockpitSessionToken();
    expect(cockpitSessionTokenMatches(expected, expected)).toBe(true);
    expect(cockpitSessionTokenMatches(expected, `${expected}extra`)).toBe(false);
    expect(cockpitSessionTokenMatches(expected, "x")).toBe(false);

    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
    for (const [left, right] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(left).toBeInstanceOf(Buffer);
      expect(right).toBeInstanceOf(Buffer);
      expect(left.byteLength).toBe(32);
      expect(right.byteLength).toBe(32);
    }
  });

  it("parses only a strict Bearer credential", () => {
    const token = generateCockpitSessionToken();
    expect(readCockpitBearerToken(`Bearer ${token}`)).toBe(token);
    for (const authorization of [
      undefined,
      "",
      token,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token} `,
      "Bearer contains=padding",
      "Basic Zm9vOmJhcg=="
    ]) {
      expect(readCockpitBearerToken(authorization), String(authorization)).toBeUndefined();
    }
  });
});
