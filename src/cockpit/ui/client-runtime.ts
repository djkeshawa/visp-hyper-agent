/**
 * Configuration baked in from the server contracts, the mutable page state,
 * the one-shot session-token read, and the request and connection helpers.
 *
 * One fragment of the Cockpit client program. The fragments are concatenated
 * in a fixed order by `client-script.ts` — see that file for why the order is
 * what it is. Keep this text free of backticks and of ${...}, which would be
 * read as template syntax rather than shipped to the browser.
 */

import {
  COCKPIT_API_PATHS,
  COCKPIT_API_VERSION,
  COCKPIT_NAVIGATION
} from "../contracts.js";

const serializedNavigation = JSON.stringify(COCKPIT_NAVIGATION);
const serializedApiVersion = JSON.stringify(COCKPIT_API_VERSION);
const serializedStatePath = JSON.stringify(COCKPIT_API_PATHS.state);
const serializedEventsPath = JSON.stringify(COCKPIT_API_PATHS.events);
const serializedRunsPath = JSON.stringify(COCKPIT_API_PATHS.runs);

export const COCKPIT_CLIENT_RUNTIME = String.raw`"use strict";

const screenDefinitions = ${serializedNavigation};
const supportedApiVersion = ${serializedApiVersion};
const statePath = ${serializedStatePath};
const eventsPath = ${serializedEventsPath};
const runsPath = ${serializedRunsPath};
const runIndexSourcePath = ".visp/runs/index.json";
const runsPageLimit = 64;
const runTailMaxRecords = 256;
const runTailMaxBytes = 2 * 1024 * 1024;
const runTailTextEncoder = new TextEncoder();
const validStates = new Set(["present", "uninitialized", "missing", "stale", "corrupt", "unavailable"]);
const navigationButtons = Array.from(document.querySelectorAll("[data-screen]"));
const main = document.getElementById("main-content");
const screenTitle = document.getElementById("screen-title");
const screenContext = document.getElementById("screen-context");
const screenState = document.getElementById("screen-state");
const screenContent = document.getElementById("screen-content");
const connection = document.querySelector(".connection");
const connectionState = document.getElementById("connection-state");
const palette = document.getElementById("command-palette");
const paletteTrigger = document.getElementById("palette-trigger");
const paletteClose = document.getElementById("palette-close");
const paletteSearch = document.getElementById("palette-search");
const paletteResults = document.getElementById("palette-results");
const paletteStatus = document.getElementById("palette-status");
const sessionToken = readAndRemoveSessionToken();
let selectedScreen = "now";
let currentState = null;
let refreshPending = false;
let stateRequestEpoch = 0;
let liveUpdateState = sessionToken ? "connecting" : "unavailable";
let liveUpdateEpoch = 0;
let liveStateEpoch = -1;
let stateLoadStatus = sessionToken ? "idle" : "authentication";
let runsVisitedOffsets = [0];
let runsRequestEpoch = 0;
let runEventsRequestEpoch = 0;
let selectedRunId = "";
let runTailEvents = [];
let runTailBytes = 0;
let runTailOmittedCount = 0;
let runTailOffset = 0;
let runTailGeneration = "";
let runsEventsMount = null;

function readAndRemoveSessionToken() {
  const initialUrl = new URL(window.location.href);
  const fragmentParameters = new URLSearchParams(initialUrl.hash.startsWith("#") ? initialUrl.hash.slice(1) : "");
  const token = initialUrl.searchParams.get("token") || fragmentParameters.get("token") || "";
  const hadToken = initialUrl.searchParams.has("token") || fragmentParameters.has("token");

  if (hadToken) {
    initialUrl.searchParams.delete("token");
    fragmentParameters.delete("token");
    initialUrl.hash = fragmentParameters.size > 0 ? "#" + fragmentParameters.toString() : "";
    window.history.replaceState(window.history.state, "", initialUrl.pathname + initialUrl.search + initialUrl.hash);
  }

  return token;
}

function sameOriginUrl(path) {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error("Cockpit requests must remain same-origin.");
  return url;
}

function authenticatedHeaders() {
  const headers = new Headers({ Accept: "application/json" });
  if (sessionToken) headers.set("Authorization", "Bearer " + sessionToken);
  return headers;
}

function setConnection(message, tone) {
  connectionState.textContent = message;
  connection.dataset.tone = tone;
}

function renderConnectionStatus() {
  if (!sessionToken || stateLoadStatus === "authentication") {
    setConnection("Authentication unavailable", "unavailable");
  } else if (liveUpdateState === "unavailable") {
    setConnection("Live updates unavailable", "unavailable");
  } else if (liveUpdateState === "reconnecting") {
    setConnection("Reconnecting", "unavailable");
  } else if (liveUpdateState === "connecting") {
    setConnection("Connecting live updates", "unavailable");
  } else if (stateLoadStatus === "unavailable") {
    setConnection("State unavailable", "unavailable");
  } else if (stateLoadStatus === "corrupt") {
    setConnection("State contract corrupt", "corrupt");
  } else if (stateLoadStatus === "loading" || liveStateEpoch !== liveUpdateEpoch) {
    setConnection("Refreshing local state", "unavailable");
  } else {
    setConnection("Live local state", "present");
  }
}`;
