import {
  COCKPIT_API_PATHS,
  COCKPIT_API_VERSION,
  COCKPIT_NAVIGATION
} from "./contracts.js";

export const COCKPIT_STYLE_PATH = "/assets/cockpit.css" as const;
export const COCKPIT_SCRIPT_PATH = "/assets/cockpit.js" as const;
export const COCKPIT_REFERRER_POLICY = "no-referrer" as const;

export const COCKPIT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "media-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'"
].join("; ");

export const COCKPIT_DOCUMENT_HEADERS = Object.freeze({
  "Content-Security-Policy": COCKPIT_CONTENT_SECURITY_POLICY,
  "Referrer-Policy": COCKPIT_REFERRER_POLICY
} as const);

const cockpitNavigationMarkup = COCKPIT_NAVIGATION.map(
  ({ id, label }, index) =>
    `<li><button type="button" data-screen="${id}"${index === 0 ? ' aria-current="page"' : ""}>${label}</button></li>`
).join("\n          ");

export const COCKPIT_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="referrer" content="${COCKPIT_REFERRER_POLICY}">
    <title>Visp Cockpit</title>
    <link rel="stylesheet" href="${COCKPIT_STYLE_PATH}">
    <script type="module" src="${COCKPIT_SCRIPT_PATH}"></script>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="topbar">
      <div class="identity">
        <p class="eyebrow">Local artifact surface · read only</p>
        <h1>Visp Cockpit</h1>
      </div>
      <div class="topbar-actions">
        <p class="connection" aria-live="polite">
          <span class="connection-dot" aria-hidden="true"></span>
          <span id="connection-state">Connecting</span>
        </p>
        <button class="palette-trigger" id="palette-trigger" type="button" aria-haspopup="dialog">
          Command palette <kbd>Ctrl K</kbd>
        </button>
      </div>
    </header>

    <div class="layout">
      <nav class="screen-nav" aria-label="Cockpit screens">
        <ul>
          ${cockpitNavigationMarkup}
        </ul>
      </nav>

      <main id="main-content" tabindex="-1">
        <section class="screen" aria-labelledby="screen-title">
          <header class="screen-header">
            <div>
              <p class="screen-context" id="screen-context">Artifact-backed state</p>
              <h2 id="screen-title">Now</h2>
            </div>
            <span class="state-badge" id="screen-state" data-state="unavailable">Unavailable</span>
          </header>
          <div class="screen-content" id="screen-content" aria-live="polite" aria-busy="true">
            <article class="degraded-panel" data-state="unavailable">
              <h3>Loading local artifacts</h3>
              <p>The Cockpit is waiting for its authenticated state response.</p>
            </article>
          </div>
        </section>
      </main>
    </div>

    <dialog id="command-palette" aria-labelledby="palette-title" aria-describedby="palette-help">
      <div class="palette-heading">
        <div>
          <p class="eyebrow">Navigate or copy</p>
          <h2 id="palette-title">Command palette</h2>
        </div>
        <button class="icon-button" id="palette-close" type="button" aria-label="Close command palette">×</button>
      </div>
      <p id="palette-help">Commands are quoted from artifacts and can only be copied.</p>
      <label class="search-label" for="palette-search">Filter actions</label>
      <input id="palette-search" type="search" autocomplete="off" spellcheck="false">
      <div class="palette-results" id="palette-results"></div>
      <p class="palette-status" id="palette-status" aria-live="polite"></p>
    </dialog>

    <noscript>
      <p class="noscript">JavaScript is required to authenticate and render local artifact state.</p>
    </noscript>
  </body>
</html>`;

export const COCKPIT_CSS = String.raw`:root {
  color-scheme: dark;
  --bg: #0a0f14;
  --panel: #111820;
  --panel-raised: #17212b;
  --border: #2b3946;
  --border-strong: #435669;
  --text: #ecf2f8;
  --muted: #9baebe;
  --accent: #7dd3fc;
  --accent-strong: #38bdf8;
  --present: #4ade80;
  --uninitialized: #94a3b8;
  --missing: #facc15;
  --stale: #fb923c;
  --corrupt: #fb7185;
  --unavailable: #c4b5fd;
  --radius: 0.7rem;
  --shadow: 0 1.2rem 3.2rem rgb(0 0 0 / 35%);
}

* {
  box-sizing: border-box;
}

html {
  min-width: 20rem;
  background: var(--bg);
}

body {
  min-height: 100vh;
  margin: 0;
  color: var(--text);
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  line-height: 1.5;
}

button,
input {
  font: inherit;
}

button {
  color: inherit;
}

button:focus-visible,
input:focus-visible,
a:focus-visible {
  outline: 0.18rem solid var(--accent);
  outline-offset: 0.16rem;
}

.skip-link {
  position: fixed;
  z-index: 20;
  top: 0.75rem;
  left: 0.75rem;
  padding: 0.55rem 0.8rem;
  color: var(--bg);
  background: var(--accent);
  transform: translateY(-200%);
}

.skip-link:focus {
  transform: translateY(0);
}

.topbar {
  position: sticky;
  z-index: 10;
  top: 0;
  display: flex;
  min-height: 5rem;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.8rem clamp(1rem, 3vw, 2.5rem);
  border-bottom: 1px solid var(--border);
  background: rgb(10 15 20 / 96%);
}

.identity h1,
.screen-header h2,
.palette-heading h2 {
  margin: 0;
  letter-spacing: -0.035em;
}

.identity h1 {
  font-size: clamp(1.15rem, 3vw, 1.55rem);
}

.eyebrow,
.screen-context {
  margin: 0 0 0.2rem;
  color: var(--muted);
  font-size: 0.72rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.topbar-actions,
.connection {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.connection {
  margin: 0;
  color: var(--muted);
  font-size: 0.8rem;
}

.connection-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: var(--unavailable);
  box-shadow: 0 0 0.7rem currentColor;
}

.connection[data-tone="present"] .connection-dot {
  background: var(--present);
}

.connection[data-tone="corrupt"] .connection-dot {
  background: var(--corrupt);
}

.palette-trigger,
.icon-button,
.screen-nav button,
.palette-action,
.runs-action {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--panel);
  cursor: pointer;
}

.palette-trigger {
  padding: 0.58rem 0.75rem;
}

kbd {
  margin-left: 0.5rem;
  padding: 0.08rem 0.32rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.25rem;
  color: var(--muted);
  font-size: 0.72rem;
}

.layout {
  display: grid;
  grid-template-columns: minmax(12rem, 15rem) minmax(0, 1fr);
  min-height: calc(100vh - 5rem);
}

.screen-nav {
  padding: 1.3rem 1rem;
  border-right: 1px solid var(--border);
  background: #0d131a;
}

.screen-nav ul {
  position: sticky;
  top: 6.3rem;
  display: grid;
  gap: 0.28rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.screen-nav button {
  width: 100%;
  padding: 0.62rem 0.75rem;
  border-color: transparent;
  color: var(--muted);
  text-align: left;
  background: transparent;
}

.screen-nav button:hover {
  color: var(--text);
  background: var(--panel);
}

.screen-nav button[aria-current="page"] {
  border-color: var(--border-strong);
  color: var(--text);
  background: var(--panel-raised);
  box-shadow: inset 0.2rem 0 var(--accent-strong);
}

main {
  width: 100%;
  max-width: 92rem;
  margin: 0 auto;
  padding: clamp(1rem, 4vw, 3rem);
}

.screen {
  min-height: 28rem;
  padding: clamp(1rem, 3vw, 2rem);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: var(--shadow);
}

.screen-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1.15rem;
  border-bottom: 1px solid var(--border);
}

.screen-header h2 {
  font-size: clamp(1.8rem, 6vw, 3.4rem);
}

.state-badge {
  display: inline-flex;
  align-items: center;
  min-height: 1.8rem;
  padding: 0.28rem 0.6rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  color: var(--unavailable);
  font-size: 0.72rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.state-badge[data-state="present"] { color: var(--present); }
.state-badge[data-state="uninitialized"] { color: var(--uninitialized); }
.state-badge[data-state="missing"] { color: var(--missing); }
.state-badge[data-state="stale"] { color: var(--stale); }
.state-badge[data-state="corrupt"] { color: var(--corrupt); }
.state-badge[data-state="unavailable"] { color: var(--unavailable); }

.screen-content {
  display: grid;
  gap: 1rem;
  padding-top: 1.25rem;
}

.source-banner,
.degraded-panel,
.artifact-section,
.artifact-value {
  border: 1px solid var(--border);
  border-radius: 0.55rem;
  background: var(--panel-raised);
}

.source-banner,
.degraded-panel,
.artifact-section {
  padding: 1rem;
}

.source-banner,
.source-path {
  color: var(--muted);
  font-size: 0.76rem;
}

.source-banner {
  margin: 0;
}

.source-banner code,
.source-path code,
.artifact-value dd,
.palette-command {
  overflow-wrap: anywhere;
}

.artifact-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
  gap: 0.8rem;
  margin: 0;
}

.artifact-value {
  min-width: 0;
  padding: 0.9rem;
}

.artifact-value dt {
  color: var(--muted);
  font-size: 0.76rem;
}

.artifact-value dd {
  margin: 0.35rem 0 0;
  font-size: 1rem;
  white-space: pre-wrap;
}

.source-path {
  margin: 0.8rem 0 0;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}

.artifact-section h3,
.degraded-panel h3 {
  margin: 0 0 0.7rem;
}

.artifact-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.9rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.artifact-heading h3 {
  margin: 0;
}

.artifact-id {
  margin: 0 0 0.18rem;
  color: var(--muted);
  font-size: 0.72rem;
}

.degraded-panel {
  border-left: 0.24rem solid var(--unavailable);
}

.degraded-panel[data-state="uninitialized"] { border-left-color: var(--uninitialized); }
.degraded-panel[data-state="missing"] { border-left-color: var(--missing); }
.degraded-panel[data-state="stale"] { border-left-color: var(--stale); }
.degraded-panel[data-state="corrupt"] { border-left-color: var(--corrupt); }

.runs-list,
.run-events-list {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.run-record,
.run-event-record {
  min-width: 0;
  padding: 0.8rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  background: var(--bg);
}

.run-record header,
.runs-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.run-record h4,
.run-events-heading {
  margin: 0;
}

.run-record pre,
.run-event-record pre {
  max-height: 18rem;
  margin: 0.75rem 0 0;
  overflow: auto;
  color: var(--muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.runs-controls {
  margin-top: 0.9rem;
}

.runs-action {
  padding: 0.5rem 0.7rem;
}

.runs-action:hover:not(:disabled) {
  border-color: var(--accent-strong);
}

.runs-action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

dialog {
  width: min(44rem, calc(100vw - 2rem));
  max-height: min(42rem, calc(100vh - 2rem));
  padding: 1.2rem;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  color: var(--text);
  background: var(--panel);
  box-shadow: var(--shadow);
}

dialog::backdrop {
  background: rgb(0 0 0 / 72%);
}

.palette-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}

.icon-button {
  width: 2.3rem;
  height: 2.3rem;
  font-size: 1.3rem;
}

.search-label {
  display: block;
  margin: 1rem 0 0.3rem;
  color: var(--muted);
  font-size: 0.78rem;
}

#palette-search {
  width: 100%;
  padding: 0.7rem;
  border: 1px solid var(--border-strong);
  border-radius: 0.45rem;
  color: var(--text);
  background: var(--bg);
}

.palette-results {
  display: grid;
  gap: 1rem;
  max-height: 22rem;
  margin-top: 1rem;
  overflow: auto;
}

.palette-group h3 {
  margin: 0 0 0.45rem;
  color: var(--muted);
  font-size: 0.76rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.palette-list {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.palette-action {
  display: grid;
  width: 100%;
  gap: 0.15rem;
  padding: 0.7rem;
  text-align: left;
}

.palette-action:hover {
  border-color: var(--accent-strong);
}

.palette-detail,
.palette-provenance,
.palette-status {
  color: var(--muted);
  font-size: 0.75rem;
}

.palette-provenance {
  overflow-wrap: anywhere;
}

.palette-status {
  min-height: 1.2rem;
  margin-bottom: 0;
}

.noscript {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  left: 1rem;
  padding: 1rem;
  border: 1px solid var(--corrupt);
  background: var(--panel);
}

@media (max-width: 48rem) {
  .topbar {
    position: static;
    align-items: flex-start;
  }

  .connection {
    display: none;
  }

  .layout {
    display: block;
  }

  .screen-nav {
    padding: 0.65rem;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .screen-nav ul {
    position: static;
    display: flex;
    width: max-content;
  }

  .screen-nav button {
    width: auto;
    min-width: 5.5rem;
    text-align: center;
  }

  .screen-nav button[aria-current="page"] {
    box-shadow: inset 0 -0.2rem var(--accent-strong);
  }

  main {
    padding: 0.8rem;
  }

  .screen-header {
    align-items: flex-end;
  }
}

@media (max-width: 32rem) {
  .palette-trigger kbd {
    display: none;
  }

  .screen-header {
    display: grid;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
  }
}`;

const serializedNavigation = JSON.stringify(COCKPIT_NAVIGATION);
const serializedApiVersion = JSON.stringify(COCKPIT_API_VERSION);
const serializedStatePath = JSON.stringify(COCKPIT_API_PATHS.state);
const serializedEventsPath = JSON.stringify(COCKPIT_API_PATHS.events);
const serializedRunsPath = JSON.stringify(COCKPIT_API_PATHS.runs);

export const COCKPIT_JAVASCRIPT = String.raw`"use strict";

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
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isArtifactScalar(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function displayValue(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function sourceLine(prefix, path) {
  const line = textElement("p", "source-path", prefix + ": ");
  line.append(textElement("code", "", path));
  return line;
}

function setBadge(state) {
  const safeState = validStates.has(state) ? state : "unavailable";
  screenState.hidden = false;
  screenState.dataset.state = safeState;
  screenState.textContent = safeState;
}

function clearScreenBadge() {
  screenState.hidden = true;
  screenState.removeAttribute("data-state");
  screenState.textContent = "";
}

function contractFailure(reason, expectedPath) {
  setBadge("corrupt");
  screenContent.replaceChildren(degradedPanel("corrupt", reason, expectedPath, ""));
  screenContent.setAttribute("aria-busy", "false");
}

function renderUnavailable(reason, expectedPath) {
  setBadge("unavailable");
  screenContent.replaceChildren(degradedPanel("unavailable", reason, expectedPath, ""));
  screenContent.setAttribute("aria-busy", "false");
}

function degradedPanel(state, reason, expectedPath, sourcePath) {
  const panel = document.createElement("article");
  panel.className = "degraded-panel";
  panel.dataset.state = state;
  panel.append(textElement("h3", "", state.toUpperCase()));
  panel.append(textElement("p", "", reason));
  panel.append(sourceLine("Expected path", expectedPath));
  if (sourcePath) panel.append(sourceLine("Source path", sourcePath));
  return panel;
}

function artifactGrid(values) {
  const grid = document.createElement("dl");
  grid.className = "artifact-grid";
  for (const item of values) {
    const card = document.createElement("div");
    card.className = "artifact-value";
    card.append(textElement("dt", "", item.label));
    card.append(textElement("dd", "", displayValue(item.value)));
    card.append(sourceLine("Source path", item.sourcePath));
    grid.append(card);
  }
  return grid;
}

function validArtifactValues(values) {
  return Array.isArray(values) && values.length > 0 && values.every(function (item) {
    return item && hasText(item.label) && isArtifactScalar(item.value) && isArtifactPath(item.sourcePath);
  });
}

function isArtifactPath(path) {
  if (!hasText(path) || !path.startsWith(".visp/")) return false;
  if (path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("%")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  const segments = path.split("/");
  return segments.length > 1 && segments[0] === ".visp" && segments.slice(1).every(function (segment) {
    return segment.length > 0 && segment !== "." && segment !== "..";
  });
}

function validScreenSourcePath(screenId, path) {
  if (!isArtifactPath(path)) return false;
  if (screenId !== "memory") return true;
  return [
    ".visp/memory/constitution.md",
    ".visp/memory/patterns.md",
    ".visp/memory/project-summary.md"
  ].includes(path);
}

function validScreenArtifactValues(screenId, values) {
  return validArtifactValues(values) && values.every(function (item) {
    return validScreenSourcePath(screenId, item.sourcePath);
  });
}

function artifactHeader(artifact, state) {
  const header = document.createElement("header");
  header.className = "artifact-heading";
  const identity = document.createElement("div");
  identity.append(textElement("p", "artifact-id", artifact.id));
  identity.append(textElement("h3", "", artifact.label));
  const badge = textElement("span", "state-badge", state);
  badge.dataset.state = state;
  header.append(identity, badge);
  return header;
}

function artifactContractFailure(artifact, index, reason) {
  const identity = {
    id: artifact && hasText(artifact.id) ? artifact.id : "invalid-artifact-" + String(index + 1),
    label: artifact && hasText(artifact.label) ? artifact.label : "Invalid artifact view"
  };
  const panel = document.createElement("article");
  panel.className = "degraded-panel";
  panel.dataset.state = "corrupt";
  panel.append(artifactHeader(identity, "corrupt"));
  panel.append(textElement("p", "", reason));
  panel.append(sourceLine("Expected path", artifact && hasText(artifact.expectedPath) ? artifact.expectedPath : statePath));
  return panel;
}

function renderArtifact(screenId, artifact, index) {
  if (!artifact || !hasText(artifact.id) || !hasText(artifact.label) || !validStates.has(artifact.state)) {
    return artifactContractFailure(artifact, index, "The API supplied an artifact view without a valid identity or state.");
  }

  if (artifact.state === "present") {
    if (!validScreenSourcePath(screenId, artifact.sourcePath) || !validScreenArtifactValues(screenId, artifact.values)) {
      return artifactContractFailure(artifact, index, "The API declared this artifact present without complete values and provenance.");
    }
    const article = document.createElement("article");
    article.className = "artifact-section";
    article.append(artifactHeader(artifact, "present"));
    const source = textElement("p", "source-banner", "Artifact source path: ");
    source.append(textElement("code", "", artifact.sourcePath));
    article.append(source, artifactGrid(artifact.values));
    return article;
  }

  if (!hasText(artifact.reason) || !validScreenSourcePath(screenId, artifact.expectedPath)) {
    return artifactContractFailure(artifact, index, "A degraded artifact omitted its reason or valid expected path.");
  }
  if ((artifact.state === "stale" || artifact.state === "corrupt") && !validScreenSourcePath(screenId, artifact.sourcePath)) {
    return artifactContractFailure(artifact, index, "An on-disk degraded artifact omitted its valid source path.");
  }
  if (artifact.sourcePath && !validScreenSourcePath(screenId, artifact.sourcePath)) {
    return artifactContractFailure(artifact, index, "A degraded artifact supplied a source path outside its interface contract.");
  }

  const panel = document.createElement("article");
  panel.className = "degraded-panel";
  panel.dataset.state = artifact.state;
  panel.append(artifactHeader(artifact, artifact.state));
  panel.append(textElement("p", "", artifact.reason));
  panel.append(sourceLine("Expected path", artifact.expectedPath));
  if (artifact.sourcePath) panel.append(sourceLine("Source path", artifact.sourcePath));
  return panel;
}

const validApiErrorCodes = new Set([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "unprocessable",
  "internal_error"
]);

function validApiErrorArtifact(artifact) {
  if (!artifact || !validStates.has(artifact.state) || artifact.state === "present") return false;
  if (!isArtifactPath(artifact.expectedPath)) return false;
  if (artifact.sourcePath !== undefined && !isArtifactPath(artifact.sourcePath)) return false;
  return (artifact.state !== "stale" && artifact.state !== "corrupt") || isArtifactPath(artifact.sourcePath);
}

function validApiError(candidate, expectedPath) {
  if (
    !candidate ||
    candidate.apiVersion !== supportedApiVersion ||
    candidate.kind !== "error" ||
    !candidate.error ||
    !validApiErrorCodes.has(candidate.error.code) ||
    !hasText(candidate.error.message) ||
    candidate.error.message.length > 512
  ) {
    return false;
  }
  if (candidate.error.artifact !== undefined) {
    if (!validApiErrorArtifact(candidate.error.artifact)) return false;
    if (candidate.error.artifact.expectedPath !== expectedPath) return false;
    if (candidate.error.artifact.sourcePath !== undefined && candidate.error.artifact.sourcePath !== expectedPath) return false;
  }
  return Object.keys(candidate).every(function (key) { return key === "apiVersion" || key === "kind" || key === "error"; }) &&
    Object.keys(candidate.error).every(function (key) { return key === "code" || key === "message" || key === "artifact"; });
}

function apiFailurePanel(candidate, fallbackPath) {
  if (!validApiError(candidate, fallbackPath)) {
    return degradedPanel("corrupt", "The local API returned a malformed error envelope.", fallbackPath, "");
  }
  const artifact = candidate.error.artifact;
  return degradedPanel(
    artifact ? artifact.state : "unavailable",
    candidate.error.message,
    artifact ? artifact.expectedPath : fallbackPath,
    artifact && artifact.sourcePath ? artifact.sourcePath : ""
  );
}

function isSafeRunId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) && value !== "." && value !== "..";
}

function isTerminalRunsCursorInvalidation(candidate) {
  return candidate.offset > 0 && candidate.runs.length === 0 && candidate.nextOffset === null && candidate.offset >= candidate.total;
}

function recoverInvalidRunsCursor(page) {
  if (!isTerminalRunsCursorInvalidation(page)) return false;
  const survivingOffsets = runsVisitedOffsets.filter(function (visitedOffset) {
    return visitedOffset === 0 || visitedOffset < page.total;
  });
  runsVisitedOffsets = survivingOffsets.length > 0 ? survivingOffsets : [0];
  resetRunTail();
  void loadRunsPage(runsVisitedOffsets[runsVisitedOffsets.length - 1] || 0);
  return true;
}

function validRunsPage(candidate, requestedOffset) {
  if (
    !candidate ||
    candidate.apiVersion !== supportedApiVersion ||
    candidate.kind !== "runs-page" ||
    candidate.sourcePath !== ".visp/runs/index.json" ||
    !Array.isArray(candidate.runs) ||
    !Number.isSafeInteger(candidate.offset) ||
    candidate.offset !== requestedOffset ||
    !Number.isSafeInteger(candidate.limit) ||
    candidate.limit < 1 ||
    candidate.limit > 100 ||
    !Number.isSafeInteger(candidate.total) ||
    candidate.total < 0 ||
    (candidate.nextOffset !== null && (!Number.isSafeInteger(candidate.nextOffset) || candidate.nextOffset < 0))
  ) {
    return false;
  }
  const cursorInvalidated = isTerminalRunsCursorInvalidation(candidate);
  if (candidate.runs.length > candidate.limit || (!cursorInvalidated && candidate.offset + candidate.runs.length > candidate.total)) return false;
  if (candidate.runs.length === 0 && candidate.offset < candidate.total) return false;
  if (candidate.nextOffset === null && candidate.offset + candidate.runs.length < candidate.total) return false;
  if (candidate.nextOffset !== null && candidate.nextOffset <= candidate.offset) return false;
  if (candidate.nextOffset !== null && candidate.nextOffset !== candidate.offset + candidate.runs.length) return false;
  return candidate.runs.every(function (run) {
    return run && typeof run === "object" && isSafeRunId(run.id) && hasText(run.startedAt);
  });
}

function jsonBlock(value, className) {
  const block = document.createElement("pre");
  block.className = className;
  block.textContent = JSON.stringify(value, null, 2);
  return block;
}

function clearRunsBrowser() {
  for (const node of Array.from(screenContent.querySelectorAll("[data-runs-browser]"))) node.remove();
  runsEventsMount = null;
}

function resetRunTail() {
  runEventsRequestEpoch += 1;
  selectedRunId = "";
  runTailEvents = [];
  runTailBytes = 0;
  runTailOmittedCount = 0;
  runTailOffset = 0;
  runTailGeneration = "";
  runsEventsMount = null;
}

function runTailPanel() {
  const panel = document.createElement("section");
  panel.className = "artifact-section";
  panel.dataset.runEvents = "true";
  if (!selectedRunId) {
    panel.append(textElement("h3", "run-events-heading", "Run events"));
    panel.append(textElement("p", "", "Choose a validated run to read its event artifact."));
    return panel;
  }

  panel.append(textElement("h3", "run-events-heading", "Events · " + selectedRunId));
  panel.append(sourceLine("Source path", ".visp/runs/" + selectedRunId + "/events.jsonl"));
  if (runTailOmittedCount > 0) {
    panel.append(textElement(
      "p",
      "degraded-note",
      String(runTailOmittedCount) + " earlier or oversized event record(s) are omitted from this bounded display. The source artifact is unchanged."
    ));
  }
  const list = document.createElement("ol");
  list.className = "run-events-list";
  if (runTailEvents.length === 0) {
    const empty = document.createElement("li");
    empty.className = "run-event-record";
    empty.append(textElement("p", "", "No complete event records are available at this byte cursor."));
    list.append(empty);
  } else {
    for (const event of runTailEvents) {
      const item = document.createElement("li");
      item.className = "run-event-record";
      item.append(jsonBlock(event, "run-event-json"));
      list.append(item);
    }
  }
  panel.append(list);
  panel.append(textElement("p", "source-path", "Next byte offset: " + String(runTailOffset)));
  const refresh = textElement("button", "runs-action", "Load new events");
  refresh.type = "button";
  refresh.addEventListener("click", function () { void loadRunEvents(); });
  panel.append(refresh);
  return panel;
}

function appendBoundedRunEvents(events) {
  for (const event of events) {
    runTailEvents.push(event);
    runTailBytes += runTailTextEncoder.encode(JSON.stringify(event, null, 2)).byteLength;
  }
  while (runTailEvents.length > runTailMaxRecords || runTailBytes > runTailMaxBytes) {
    const removed = runTailEvents.shift();
    if (removed === undefined) break;
    runTailBytes -= runTailTextEncoder.encode(JSON.stringify(removed, null, 2)).byteLength;
    runTailOmittedCount = Math.min(Number.MAX_SAFE_INTEGER, runTailOmittedCount + 1);
  }
}

function replaceRunTailPanel(node) {
  if (!runsEventsMount) return;
  runsEventsMount.replaceChildren(node);
}

function validRunEventsPage(candidate, requestedOffset) {
  if (
    !candidate ||
    candidate.apiVersion !== supportedApiVersion ||
    candidate.kind !== "run-events-page" ||
    candidate.runId !== selectedRunId ||
    candidate.sourcePath !== ".visp/runs/" + selectedRunId + "/events.jsonl" ||
    !Array.isArray(candidate.events) ||
    !Number.isSafeInteger(candidate.offset) ||
    !Number.isSafeInteger(candidate.nextOffset) ||
    candidate.offset < 0 ||
    candidate.nextOffset < candidate.offset ||
    typeof candidate.rotated !== "boolean" ||
    !hasText(candidate.generation) ||
    candidate.generation.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(candidate.generation)
  ) {
    return false;
  }
  if (candidate.rotated ? candidate.offset !== 0 : candidate.offset !== requestedOffset) return false;
  if ((candidate.events.length === 0) !== (candidate.nextOffset === candidate.offset)) return false;
  for (const event of candidate.events) {
    if (!event || typeof event !== "object" || event.runId !== selectedRunId) return false;
  }
  return true;
}

async function loadRunEvents() {
  if (!sessionToken || !isSafeRunId(selectedRunId) || !runsEventsMount) return;
  const requestEpoch = ++runEventsRequestEpoch;
  const requestedOffset = runTailOffset;
  const url = sameOriginUrl(runsPath + "/" + encodeURIComponent(selectedRunId) + "/events");
  url.searchParams.set("offset", String(runTailOffset));
  if (runTailGeneration) url.searchParams.set("generation", runTailGeneration);

  let response;
  try {
    response = await fetch(sameOriginUrl(url), {
      method: "GET",
      headers: authenticatedHeaders(),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    });
  } catch {
    if (requestEpoch === runEventsRequestEpoch) {
      replaceRunTailPanel(degradedPanel("unavailable", "The run-event request could not connect.", ".visp/runs/" + selectedRunId + "/events.jsonl", ""));
    }
    return;
  }

  let candidate;
  try {
    candidate = await response.json();
  } catch {
    if (requestEpoch === runEventsRequestEpoch) {
      replaceRunTailPanel(degradedPanel("corrupt", "The run-event endpoint returned malformed JSON.", ".visp/runs/" + selectedRunId + "/events.jsonl", ""));
    }
    return;
  }
  if (requestEpoch !== runEventsRequestEpoch || selectedScreen !== "runs") return;
  if (!response.ok) {
    replaceRunTailPanel(apiFailurePanel(candidate, ".visp/runs/" + selectedRunId + "/events.jsonl"));
    return;
  }
  if (!validRunEventsPage(candidate, requestedOffset)) {
    replaceRunTailPanel(degradedPanel("corrupt", "The run-event endpoint returned an invalid versioned page.", ".visp/runs/" + selectedRunId + "/events.jsonl", ""));
    return;
  }

  const page = candidate;
  if (page.rotated) {
    runTailEvents = [];
    runTailBytes = 0;
    runTailOmittedCount = 0;
  }
  appendBoundedRunEvents(page.events);
  runTailOffset = page.nextOffset;
  runTailGeneration = page.generation;
  replaceRunTailPanel(runTailPanel());
}

function selectRun(runId) {
  if (!isSafeRunId(runId)) return;
  runEventsRequestEpoch += 1;
  selectedRunId = runId;
  runTailEvents = [];
  runTailBytes = 0;
  runTailOmittedCount = 0;
  runTailOffset = 0;
  runTailGeneration = "";
  replaceRunTailPanel(runTailPanel());
  void loadRunEvents();
}

function renderRunsPage(page) {
  clearRunsBrowser();
  const browser = document.createElement("section");
  browser.className = "artifact-section";
  browser.dataset.runsBrowser = "true";
  browser.append(textElement("h3", "", "Run history"));
  browser.append(sourceLine("Source path", page.sourcePath));
  browser.append(textElement("p", "", "Records " + String(page.offset) + "–" + String(page.offset + page.runs.length) + " of " + String(page.total) + "."));

  const list = document.createElement("ol");
  list.className = "runs-list";
  if (page.runs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "run-record";
    empty.append(textElement("p", "", "No run records are present on this page."));
    list.append(empty);
  } else {
    for (const run of page.runs) {
      const item = document.createElement("li");
      item.className = "run-record";
      const header = document.createElement("header");
      header.append(textElement("h4", "", run.id));
      const events = textElement("button", "runs-action", "Read events");
      events.type = "button";
      events.addEventListener("click", function () { selectRun(run.id); });
      header.append(events);
      item.append(header, jsonBlock(run, "run-json"));
      list.append(item);
    }
  }
  browser.append(list);

  const controls = document.createElement("div");
  controls.className = "runs-controls";
  const previous = textElement("button", "runs-action", "Previous page");
  previous.type = "button";
  previous.disabled = runsVisitedOffsets.length <= 1;
  previous.addEventListener("click", function () {
    if (runsVisitedOffsets.length <= 1) return;
    runsVisitedOffsets.pop();
    resetRunTail();
    void loadRunsPage(runsVisitedOffsets[runsVisitedOffsets.length - 1]);
  });
  const next = textElement("button", "runs-action", "Next page");
  next.type = "button";
  next.disabled = page.nextOffset === null;
  next.addEventListener("click", function () {
    if (page.nextOffset === null) return;
    runsVisitedOffsets.push(page.nextOffset);
    resetRunTail();
    void loadRunsPage(page.nextOffset);
  });
  controls.append(previous, next);
  browser.append(controls);
  runsEventsMount = document.createElement("div");
  runsEventsMount.append(runTailPanel());
  browser.append(runsEventsMount);
  screenContent.append(browser);
}

async function loadRunsPage(offset) {
  if (!sessionToken || selectedScreen !== "runs") return;
  const requestEpoch = ++runsRequestEpoch;
  const query = new URLSearchParams({
    offset: String(offset),
    limit: String(runsPageLimit)
  });
  const runsPageUrl = runsPath + "?" + query.toString();
  let response;
  try {
    response = await fetch(sameOriginUrl(runsPageUrl), {
      method: "GET",
      headers: authenticatedHeaders(),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    });
  } catch {
    if (requestEpoch === runsRequestEpoch && selectedScreen === "runs") {
      clearRunsBrowser();
      const panel = degradedPanel("unavailable", "The Runs request could not connect.", runIndexSourcePath, "");
      panel.dataset.runsBrowser = "true";
      screenContent.append(panel);
    }
    return;
  }

  let candidate;
  try {
    candidate = await response.json();
  } catch {
    if (requestEpoch === runsRequestEpoch && selectedScreen === "runs") {
      clearRunsBrowser();
      const panel = degradedPanel("corrupt", "The Runs endpoint returned malformed JSON.", runIndexSourcePath, "");
      panel.dataset.runsBrowser = "true";
      screenContent.append(panel);
    }
    return;
  }
  if (requestEpoch !== runsRequestEpoch || selectedScreen !== "runs") return;
  if (!response.ok) {
    clearRunsBrowser();
    const panel = apiFailurePanel(candidate, runIndexSourcePath);
    panel.dataset.runsBrowser = "true";
    screenContent.append(panel);
    return;
  }
  if (!validRunsPage(candidate, offset)) {
    clearRunsBrowser();
    const panel = degradedPanel("corrupt", "The Runs endpoint returned an invalid versioned page.", runIndexSourcePath, "");
    panel.dataset.runsBrowser = "true";
    screenContent.append(panel);
    return;
  }
  if (recoverInvalidRunsCursor(candidate)) return;
  renderRunsPage(candidate);
}

function renderScreen() {
  const definition = screenDefinitions.find(function (entry) { return entry.id === selectedScreen; });
  screenTitle.textContent = definition ? definition.label : "Unknown screen";
  screenContext.textContent = selectedScreen === "memory"
    ? "Cited project context · non-authoritative"
    : "Artifact-backed state";

  if (!currentState || !currentState.screens || typeof currentState.screens !== "object") {
    renderUnavailable("Waiting for authenticated local artifact state.", statePath);
    return;
  }

  const screen = currentState.screens[selectedScreen];
  if (
    !screen ||
    screen.id !== selectedScreen ||
    !definition ||
    screen.label !== definition.label ||
    !Array.isArray(screen.artifacts) ||
    screen.artifacts.length === 0
  ) {
    contractFailure("The API did not provide a valid state for this screen.", "Not provided by the state contract");
    return;
  }

  clearScreenBadge();
  screenContent.replaceChildren(...screen.artifacts.map(function (artifact, index) {
    return renderArtifact(selectedScreen, artifact, index);
  }));
  screenContent.setAttribute("aria-busy", "false");
  if (selectedScreen === "runs") {
    const runIndex = screen.artifacts.find(function (artifact) { return artifact.id === "run-index"; });
    if (runIndex && runIndex.state === "present") {
      const offset = runsVisitedOffsets[runsVisitedOffsets.length - 1] || 0;
      void loadRunsPage(offset);
    }
  }
}

function selectScreen(id, moveFocus) {
  if (!screenDefinitions.some(function (entry) { return entry.id === id; })) return;
  selectedScreen = id;
  if (id !== "runs") {
    runsRequestEpoch += 1;
    resetRunTail();
  }
  for (const button of navigationButtons) {
    if (button.dataset.screen === id) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  renderScreen();
  if (moveFocus) main.focus();
}

async function loadState(expectedLiveEpoch) {
  const requestEpoch = ++stateRequestEpoch;
  if (!sessionToken) {
    stateLoadStatus = "authentication";
    renderConnectionStatus();
    renderUnavailable("The initial local URL did not contain a session token.", statePath);
    return;
  }

  stateLoadStatus = "loading";
  renderConnectionStatus();
  screenContent.setAttribute("aria-busy", "true");
  let response;
  try {
    response = await fetch(sameOriginUrl(statePath), {
      method: "GET",
      headers: authenticatedHeaders(),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error"
    });
  } catch (error) {
    if (requestEpoch !== stateRequestEpoch) return;
    const reason = error instanceof Error ? error.message : "The local state request could not connect.";
    stateLoadStatus = "unavailable";
    renderConnectionStatus();
    renderUnavailable(reason, statePath);
    return;
  }

  if (requestEpoch !== stateRequestEpoch) return;
  if (!response.ok) {
    stateLoadStatus = "unavailable";
    renderConnectionStatus();
    renderUnavailable("The local state endpoint returned HTTP " + response.status + ".", statePath);
    return;
  }

  let candidate;
  try {
    candidate = await response.json();
  } catch {
    if (requestEpoch !== stateRequestEpoch) return;
    stateLoadStatus = "corrupt";
    renderConnectionStatus();
    contractFailure("The local state endpoint returned malformed JSON.", statePath);
    return;
  }
  if (requestEpoch !== stateRequestEpoch) return;
  if (!candidate || candidate.apiVersion !== supportedApiVersion) {
    stateLoadStatus = "corrupt";
    renderConnectionStatus();
    contractFailure("Unsupported or missing Cockpit API version.", statePath);
    return;
  }

  currentState = candidate;
  stateLoadStatus = "available";
  if (liveUpdateState === "open" && expectedLiveEpoch === liveUpdateEpoch) {
    liveStateEpoch = expectedLiveEpoch;
  }
  renderConnectionStatus();
  renderScreen();
  renderPalette();
}

function scheduleRefresh() {
  if (refreshPending || liveUpdateState !== "open") return;
  const scheduledLiveEpoch = liveUpdateEpoch;
  refreshPending = true;
  window.setTimeout(function () {
    refreshPending = false;
    if (liveUpdateState !== "open" || scheduledLiveEpoch !== liveUpdateEpoch) return;
    void loadState(scheduledLiveEpoch);
  }, 75);
}

function connectInvalidations() {
  if (!sessionToken || typeof EventSource === "undefined") {
    liveUpdateState = "unavailable";
    renderConnectionStatus();
    return;
  }
  liveUpdateState = "connecting";
  renderConnectionStatus();
  const url = sameOriginUrl(eventsPath);
  url.searchParams.set("token", sessionToken);
  const stream = new EventSource(url);
  stream.addEventListener("open", function () {
    liveUpdateState = "open";
    liveUpdateEpoch += 1;
    renderConnectionStatus();
    void loadState(liveUpdateEpoch);
  });
  stream.addEventListener("message", scheduleRefresh);
  stream.addEventListener("invalidation", scheduleRefresh);
  stream.addEventListener("error", function () {
    liveUpdateState = "reconnecting";
    liveUpdateEpoch += 1;
    renderConnectionStatus();
  });
}

function navigationPaletteGroup(query) {
  const group = document.createElement("section");
  group.className = "palette-group";
  group.append(textElement("h3", "", "Screens"));
  const list = document.createElement("ul");
  list.className = "palette-list";
  const matches = screenDefinitions.filter(function (entry) {
    return entry.label.toLowerCase().includes(query);
  });
  for (const entry of matches) {
    const item = document.createElement("li");
    const button = textElement("button", "palette-action", entry.label);
    button.type = "button";
    button.dataset.paletteAction = "navigate";
    button.dataset.screen = entry.id;
    button.append(textElement("span", "palette-detail", "Navigate to screen"));
    item.append(button);
    list.append(item);
  }
  group.append(list);
  return group;
}

function commandUnavailable(paletteState) {
  const group = document.createElement("section");
  group.className = "palette-group";
  group.append(textElement("h3", "", "Artifact commands"));
  const panel = degradedPanel(
    "unavailable",
    paletteState && hasText(paletteState.reason) ? paletteState.reason : "No artifact-sourced command is available.",
    paletteState && hasText(paletteState.expectedPath) ? paletteState.expectedPath : "Not provided by the state contract",
    paletteState && hasText(paletteState.sourcePath) ? paletteState.sourcePath : ""
  );
  group.append(panel);
  return group;
}

function commandPaletteGroup(paletteState, query) {
  if (!paletteState || paletteState.state !== "present" || !isArtifactPath(paletteState.sourcePath) || !Array.isArray(paletteState.commands) || paletteState.commands.length === 0) {
    return commandUnavailable(paletteState);
  }
  const validCommands = paletteState.commands.filter(function (entry) {
    return entry && hasText(entry.label) && hasText(entry.command) && hasText(entry.sourcePath) && isArtifactPath(entry.sourcePath);
  });
  if (validCommands.length !== paletteState.commands.length) {
    return commandUnavailable({
      reason: "A command was withheld because its artifact provenance was incomplete.",
      expectedPath: hasText(paletteState.sourcePath) ? paletteState.sourcePath : "Not provided by the state contract"
    });
  }

  const matches = validCommands.filter(function (entry) {
    return (entry.label + " " + entry.command).toLowerCase().includes(query);
  });
  const group = document.createElement("section");
  group.className = "palette-group";
  group.append(textElement("h3", "", "Artifact commands · copy only"));
  const list = document.createElement("ul");
  list.className = "palette-list";
  for (const entry of matches) {
    const item = document.createElement("li");
    const button = textElement("button", "palette-action", entry.label);
    button.type = "button";
    button.dataset.paletteAction = "copy";
    button.dataset.commandIndex = String(validCommands.indexOf(entry));
    button.append(textElement("code", "palette-command", entry.command));
    button.append(textElement("span", "palette-provenance", "Source path: " + entry.sourcePath));
    item.append(button);
    list.append(item);
  }
  group.dataset.commands = JSON.stringify(validCommands);
  group.append(list);
  return group;
}

function renderPalette() {
  const query = paletteSearch.value.trim().toLowerCase();
  const paletteState = currentState && currentState.commandPalette;
  paletteResults.replaceChildren(
    navigationPaletteGroup(query),
    commandPaletteGroup(paletteState, query)
  );
}

async function copyCommand(button) {
  const group = button.closest(".palette-group");
  let commands;
  try {
    commands = JSON.parse(group.dataset.commands || "[]");
  } catch {
    commands = [];
  }
  const command = commands[Number(button.dataset.commandIndex)];
  if (!command || !hasText(command.command) || !isArtifactPath(command.sourcePath)) {
    paletteStatus.textContent = "Command unavailable: artifact provenance is missing.";
    return;
  }
  try {
    await navigator.clipboard.writeText(command.command);
    paletteStatus.textContent = "Copied artifact command from " + command.sourcePath + ".";
  } catch {
    paletteStatus.textContent = "Clipboard access failed. No command was executed.";
  }
}

function paletteButtons() {
  return Array.from(paletteResults.querySelectorAll("button:not([hidden])"));
}

for (const button of navigationButtons) {
  button.addEventListener("click", function () { selectScreen(button.dataset.screen, true); });
  button.addEventListener("keydown", function (event) {
    const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const current = navigationButtons.indexOf(button);
    let next = current;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (current + 1) % navigationButtons.length;
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (current - 1 + navigationButtons.length) % navigationButtons.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = navigationButtons.length - 1;
    navigationButtons[next].focus();
    selectScreen(navigationButtons[next].dataset.screen, false);
  });
}

paletteTrigger.addEventListener("click", function () {
  renderPalette();
  palette.showModal();
  paletteSearch.focus();
});
paletteClose.addEventListener("click", function () { palette.close(); });
paletteSearch.addEventListener("input", renderPalette);
paletteResults.addEventListener("click", function (event) {
  const button = event.target.closest("button[data-palette-action]");
  if (!button) return;
  if (button.dataset.paletteAction === "navigate") {
    palette.close();
    selectScreen(button.dataset.screen, true);
  } else if (button.dataset.paletteAction === "copy") {
    void copyCommand(button);
  }
});
palette.addEventListener("keydown", function (event) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = paletteButtons();
  if (buttons.length === 0) return;
  event.preventDefault();
  const current = buttons.indexOf(document.activeElement);
  const direction = event.key === "ArrowDown" ? 1 : -1;
  const next = current < 0 ? 0 : (current + direction + buttons.length) % buttons.length;
  buttons[next].focus();
});
document.addEventListener("keydown", function (event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (palette.open) palette.close();
    else {
      renderPalette();
      palette.showModal();
      paletteSearch.focus();
    }
  }
});

renderScreen();
renderPalette();
connectInvalidations();
void loadState();
`;

export type CockpitStaticAsset = Readonly<{
  path: string;
  contentType: string;
  body: string;
  headers?: Readonly<Record<string, string>>;
}>;

export const COCKPIT_STATIC_ASSETS = Object.freeze([
  Object.freeze({
    path: "/",
    contentType: "text/html; charset=utf-8",
    body: COCKPIT_HTML,
    headers: COCKPIT_DOCUMENT_HEADERS
  }),
  Object.freeze({ path: COCKPIT_STYLE_PATH, contentType: "text/css; charset=utf-8", body: COCKPIT_CSS }),
  Object.freeze({
    path: COCKPIT_SCRIPT_PATH,
    contentType: "text/javascript; charset=utf-8",
    body: COCKPIT_JAVASCRIPT
  })
] satisfies readonly CockpitStaticAsset[]);
