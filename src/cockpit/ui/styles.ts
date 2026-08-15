/**
 * The Cockpit stylesheet, served from `COCKPIT_STYLE_PATH`.
 *
 * It stays self-contained on purpose: no `@import`, no `@font-face`, no
 * `url()`. Each of those would be a network fetch the Content-Security-Policy
 * forbids, so the rule is enforced by the suite rather than left to habit.
 */

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
