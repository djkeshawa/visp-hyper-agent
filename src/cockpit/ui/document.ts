/**
 * The Cockpit document: its served paths, the headers that lock it down, and
 * the markup itself. The page carries no inline script or style — every
 * behaviour arrives through `COCKPIT_SCRIPT_PATH`, which is what lets the
 * Content-Security-Policy below stay at `'self'` with no escape hatch.
 */

import { COCKPIT_NAVIGATION } from "../contracts.js";

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
