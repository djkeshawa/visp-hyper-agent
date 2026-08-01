import type { ServerResponse } from "node:http";

import {
  COCKPIT_API_VERSION,
  isCockpitArtifactPath,
  type CockpitInvalidationV1
} from "./contracts.js";

const CONNECTED_COMMENT = ": connected\n\n";
const KEEP_ALIVE_COMMENT = ": keep-alive\n\n";
const MAX_KEEP_ALIVE_MS = 120_000;

export type CockpitSseWritable = Pick<
  ServerResponse,
  "write" | "end" | "once" | "off"
> &
  Readonly<{
    destroyed?: boolean;
    writableEnded?: boolean;
  }>;

export type CockpitSseBroadcaster = Readonly<{
  addClient: (client: CockpitSseWritable) => () => void;
  invalidate: (path: CockpitInvalidationV1["path"]) => void;
  close: () => void;
}>;

type ClientState = {
  client: CockpitSseWritable;
  blocked: boolean;
  pendingInvalidation?: string;
  detached: boolean;
  detach: () => void;
  onDrain: () => void;
  onClose: () => void;
};

export function createCockpitSseBroadcaster(
  options: Readonly<{ keepAliveMs?: number }> = {}
): CockpitSseBroadcaster {
  const keepAliveMs = validateKeepAliveMs(options.keepAliveMs);
  const clients = new Set<ClientState>();
  let closed = false;
  let keepAliveTimer: NodeJS.Timeout | undefined;

  const writeFrame = (state: ClientState, frame: string): void => {
    if (state.detached || state.client.destroyed || state.client.writableEnded) {
      state.detach();
      return;
    }
    try {
      state.blocked = !state.client.write(frame);
      if (state.blocked) state.client.once("drain", state.onDrain);
    } catch {
      state.detach();
    }
  };

  const addClient = (client: CockpitSseWritable): (() => void) => {
    if (closed) {
      safelyEnd(client);
      return () => undefined;
    }

    const state = {} as ClientState;
    const detach = (): void => {
      if (state.detached) return;
      state.detached = true;
      state.pendingInvalidation = undefined;
      clients.delete(state);
      client.off("close", state.onClose);
      client.off("error", state.onClose);
      client.off("drain", state.onDrain);
    };
    const onDrain = (): void => {
      if (state.detached) return;
      state.blocked = false;
      const pending = state.pendingInvalidation;
      state.pendingInvalidation = undefined;
      if (pending !== undefined) writeFrame(state, pending);
    };
    const onClose = (): void => detach();
    Object.assign(state, {
      client,
      blocked: false,
      detached: false,
      detach,
      onDrain,
      onClose
    });

    clients.add(state);
    client.once("close", onClose);
    client.once("error", onClose);
    writeFrame(state, CONNECTED_COMMENT);
    return detach;
  };

  const invalidate = (path: CockpitInvalidationV1["path"]): void => {
    if (closed) return;
    assertInvalidationPath(path);
    const frame = formatInvalidation(path);
    for (const state of clients) {
      if (state.blocked) state.pendingInvalidation = frame;
      else writeFrame(state, frame);
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
    keepAliveTimer = undefined;
    for (const state of [...clients]) {
      state.detach();
      safelyEnd(state.client);
    }
  };

  if (keepAliveMs !== undefined) {
    keepAliveTimer = setInterval(() => {
      for (const state of clients) {
        if (!state.blocked) writeFrame(state, KEEP_ALIVE_COMMENT);
      }
    }, keepAliveMs);
    keepAliveTimer.unref();
  }

  return Object.freeze({ addClient, invalidate, close });
}

function formatInvalidation(path: CockpitInvalidationV1["path"]): string {
  const invalidation: CockpitInvalidationV1 = Object.freeze({
    apiVersion: COCKPIT_API_VERSION,
    type: "invalidation",
    path
  });
  return `event: invalidation\ndata: ${JSON.stringify(invalidation)}\n\n`;
}

function assertInvalidationPath(path: CockpitInvalidationV1["path"]): void {
  if (path !== ".visp" && !isCockpitArtifactPath(path)) {
    throw new TypeError("Cockpit invalidation path must stay below .visp/.");
  }
}

function validateKeepAliveMs(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_KEEP_ALIVE_MS) {
    throw new TypeError(
      `Cockpit SSE keepAliveMs must be an integer from 1 through ${MAX_KEEP_ALIVE_MS}.`
    );
  }
  return value;
}

function safelyEnd(client: CockpitSseWritable): void {
  if (client.destroyed || client.writableEnded) return;
  try {
    client.end();
  } catch {
    // A disconnected client has no cleanup effect on other local streams.
  }
}
