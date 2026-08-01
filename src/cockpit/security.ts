import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const COCKPIT_BIND_HOST = "127.0.0.1" as const;
export const COCKPIT_SESSION_TOKEN_BYTES = 32 as const;

export function assertCockpitBindHost(host: string): asserts host is typeof COCKPIT_BIND_HOST {
  if (host !== COCKPIT_BIND_HOST) {
    throw new TypeError(`Cockpit must bind exactly ${COCKPIT_BIND_HOST}.`);
  }
}

export function expectedCockpitHostHeader(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Cockpit port must be an integer from 1 through 65535.");
  }
  return `${COCKPIT_BIND_HOST}:${port}`;
}

export function isValidCockpitHostHeader(
  hostHeader: string | undefined,
  actualPort: number
): boolean {
  return hostHeader === expectedCockpitHostHeader(actualPort);
}

export function assertCockpitHostHeader(
  hostHeader: string | undefined,
  actualPort: number
): void {
  if (!isValidCockpitHostHeader(hostHeader, actualPort)) {
    throw new TypeError("Cockpit request Host header does not match the loopback listener.");
  }
}

export function generateCockpitSessionToken(): string {
  return randomBytes(COCKPIT_SESSION_TOKEN_BYTES).toString("base64url");
}

/** Compare credential digests so timingSafeEqual always receives equal-length inputs. */
export function cockpitSessionTokenMatches(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

export function readCockpitBearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  return match?.[1];
}
