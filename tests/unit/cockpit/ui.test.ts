import { runInNewContext, Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { COCKPIT_NAVIGATION } from "../../../src/cockpit/contracts.js";
import {
  COCKPIT_CONTENT_SECURITY_POLICY,
  COCKPIT_CSS,
  COCKPIT_HTML,
  COCKPIT_JAVASCRIPT,
  COCKPIT_SCRIPT_PATH,
  COCKPIT_STATIC_ASSETS,
  COCKPIT_STYLE_PATH
} from "../../../src/cockpit/ui.js";

const PHASE_9_NAVIGATION = [
  { id: "now", label: "Now" },
  { id: "feature", label: "Feature" },
  { id: "scope", label: "Scope" },
  { id: "assurance", label: "Assurance" },
  { id: "review", label: "Review" },
  { id: "runs", label: "Runs" },
  { id: "memory", label: "Memory" },
  { id: "health", label: "Health" },
  { id: "reference", label: "Reference" }
] as const;

function cspDirectives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter((parts) => parts[0]?.length)
      .map(([name, ...sources]) => [name!.toLowerCase(), sources])
  );
}

function navigationFromHtml(): Array<{ id: string; label: string }> {
  return [...COCKPIT_HTML.matchAll(/<button\b[^>]*data-screen="([^"]+)"[^>]*>([^<]+)<\/button>/gu)].map(
    ([, id, label]) => ({ id: id!, label: label!.trim() })
  );
}

function staticResourceReferences(): string[] {
  return [
    ...COCKPIT_HTML.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gu)
  ].map((match) => match[1]!);
}

describe("Cockpit UI contract", () => {
  it("renders exactly the nine Phase 9 navigation entries from the shared contract", () => {
    expect(COCKPIT_NAVIGATION).toEqual(PHASE_9_NAVIGATION);
    expect(navigationFromHtml()).toEqual([...COCKPIT_NAVIGATION]);
    expect(new Set(COCKPIT_NAVIGATION.map(({ id }) => id)).size).toBe(9);
  });

  it("ships syntactically valid standalone JavaScript", () => {
    expect(() => new Script(COCKPIT_JAVASCRIPT, { filename: "cockpit.js" })).not.toThrow();
  });

  it("uses a restrictive CSP without unsafe or external execution sources", () => {
    const directives = cspDirectives(COCKPIT_CONTENT_SECURITY_POLICY);

    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'"]);
    expect(directives.get("style-src")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'self'"]);
    expect(directives.get("img-src")).toEqual(["'self'"]);
    for (const directive of [
      "font-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
      "form-action",
      "media-src",
      "worker-src",
      "manifest-src"
    ]) {
      expect(directives.get(directive), directive).toEqual(["'none'"]);
    }

    const allSources = [...directives.values()].flat().join(" ");
    expect(allSources).not.toMatch(/'unsafe-inline'|'unsafe-eval'|\*|(?:https?|wss?):|\/\//u);
  });

  it("uses only local static assets with no inline script, style, or event handlers", () => {
    expect(staticResourceReferences()).toEqual([COCKPIT_STYLE_PATH, COCKPIT_SCRIPT_PATH]);
    expect(COCKPIT_STATIC_ASSETS.map(({ path }) => path)).toEqual([
      "/",
      COCKPIT_STYLE_PATH,
      COCKPIT_SCRIPT_PATH
    ]);
    expect(COCKPIT_STATIC_ASSETS.map(({ contentType }) => contentType)).toEqual([
      "text/html; charset=utf-8",
      "text/css; charset=utf-8",
      "text/javascript; charset=utf-8"
    ]);
    for (const reference of staticResourceReferences()) {
      expect(reference).toMatch(/^\/(?!\/)/u);
      expect(COCKPIT_STATIC_ASSETS.some(({ path }) => path === reference)).toBe(true);
    }

    expect(COCKPIT_HTML).not.toMatch(/<script\b(?![^>]*\bsrc=)[^>]*>/iu);
    expect(COCKPIT_HTML).not.toMatch(/<style\b|\sstyle\s*=|\son[a-z]+\s*=/iu);
    expect(COCKPIT_HTML).not.toMatch(/(?:src|href|action)=["'](?:https?:)?\/\//iu);
    expect(COCKPIT_CSS).not.toMatch(/@import|@font-face|url\s*\(/iu);
    expect(`${COCKPIT_HTML}\n${COCKPIT_CSS}\n${COCKPIT_JAVASCRIPT}`).not.toMatch(
      /["'`](?:(?:https?|wss?):)?\/\/[A-Za-z0-9]/u
    );
  });

  it("removes the session token from history without persisting it", () => {
    expect(COCKPIT_JAVASCRIPT).toContain("const sessionToken = readAndRemoveSessionToken();");
    expect(COCKPIT_JAVASCRIPT).toContain('initialUrl.searchParams.delete("token");');
    expect(COCKPIT_JAVASCRIPT).toContain('fragmentParameters.delete("token");');
    expect(COCKPIT_JAVASCRIPT).toContain("window.history.replaceState(");
    expect(COCKPIT_JAVASCRIPT).not.toMatch(
      /localStorage|sessionStorage|document\.cookie|indexedDB/u
    );
  });

  it("keeps the command palette provenance-backed and copy-only", () => {
    expect(COCKPIT_HTML).toContain("Commands are quoted from artifacts and can only be copied.");
    expect(COCKPIT_JAVASCRIPT).toContain('hasText(entry.command) && hasText(entry.sourcePath)');
    expect(COCKPIT_JAVASCRIPT).toContain('button.dataset.paletteAction = "copy"');
    expect(COCKPIT_JAVASCRIPT).toContain("navigator.clipboard.writeText(command.command)");
    expect(COCKPIT_JAVASCRIPT).toContain('"Source path: " + entry.sourcePath');
    expect(COCKPIT_JAVASCRIPT).not.toMatch(
      /\b(?:exec|execFile|spawn|system|eval)\s*\(|new\s+Function\s*\(|child_process|window\.open\s*\(/u
    );
    expect(COCKPIT_JAVASCRIPT).not.toMatch(/(?:window\.)?location\s*=|\.submit\s*\(/u);
    expect(`${COCKPIT_HTML}\n${COCKPIT_JAVASCRIPT}`).not.toMatch(
      /["'`]visp(?:-hyper)?[ \t]+[a-z][a-z-]*(?=[ \t"'`])/u
    );
  });

  it("contains no UI-authored pass, ready, approval, or success verdict", () => {
    expect(`${COCKPIT_HTML}\n${COCKPIT_JAVASCRIPT}`).not.toMatch(
      /["'`](?:pass(?:ed)?|ready|approved|success(?:ful)?)\b/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain("artifactGrid(artifact.values)");
    expect(COCKPIT_JAVASCRIPT).toContain('sourceLine("Source path", item.sourcePath)');
  });

  it("labels Memory as cited non-authoritative project context", () => {
    expect(COCKPIT_JAVASCRIPT).toContain(
      'selectedScreen === "memory"\n    ? "Cited project context · non-authoritative"'
    );
    expect(COCKPIT_JAVASCRIPT).not.toMatch(/memory[^\n]{0,100}\b(?:is|as)\s+authoritative\b/iu);
  });

  it("keeps unavailable transport or authentication distinct from corrupt contracts", () => {
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /function renderUnavailable\([^)]*\)\s*\{[\s\S]*?setBadge\("unavailable"\)/u
    );
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /function contractFailure\([^)]*\)\s*\{[\s\S]*?setBadge\("corrupt"\)/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain(
      'setConnection("Authentication unavailable", "unavailable")'
    );
    expect(COCKPIT_JAVASCRIPT).toContain('setConnection("State unavailable", "unavailable")');
    expect(COCKPIT_JAVASCRIPT).toContain(
      'setConnection("State contract corrupt", "corrupt")'
    );
    expect(COCKPIT_JAVASCRIPT).toContain("The local state endpoint returned malformed JSON.");
    expect(COCKPIT_JAVASCRIPT).toContain("Unsupported or missing Cockpit API version.");
  });

  it("renders each sibling artifact state independently and enforces Memory provenance", () => {
    expect(COCKPIT_JAVASCRIPT).toContain("screen.artifacts.length === 0");
    expect(COCKPIT_JAVASCRIPT).toContain("clearScreenBadge();");
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /screenContent\.replaceChildren\(\.\.\.screen\.artifacts\.map\(function \(artifact, index\) \{\s*return renderArtifact\(selectedScreen, artifact, index\);\s*\}\)\);/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain("panel.append(artifactHeader(artifact, artifact.state));");
    expect(COCKPIT_JAVASCRIPT).toContain('if (screenId !== "memory") return true;');
    expect(COCKPIT_JAVASCRIPT).toContain('".visp/memory/constitution.md"');
    expect(COCKPIT_JAVASCRIPT).toContain('".visp/memory/patterns.md"');
    expect(COCKPIT_JAVASCRIPT).toContain('".visp/memory/project-summary.md"');
  });

  it("refetches state for the current invalidation-stream epoch before reporting live", () => {
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /stream\.addEventListener\("open", function \(\) \{\s*liveUpdateState = "open";\s*liveUpdateEpoch \+= 1;\s*renderConnectionStatus\(\);\s*void loadState\(liveUpdateEpoch\);\s*\}\);/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain(
      'if (liveUpdateState === "open" && expectedLiveEpoch === liveUpdateEpoch)'
    );
    expect(COCKPIT_JAVASCRIPT).toMatch(/connectInvalidations\(\);\s*void loadState\(\);/u);
    expect(COCKPIT_JAVASCRIPT).toContain('stream.addEventListener("message", scheduleRefresh);');
    expect(COCKPIT_JAVASCRIPT).toContain(
      'stream.addEventListener("invalidation", scheduleRefresh);'
    );
  });

  it("keeps unavailable and reconnecting transport states ahead of state-fetch completion", () => {
    const statusFunction = COCKPIT_JAVASCRIPT.match(
      /function renderConnectionStatus\(\) \{[\s\S]*?\n\}/u
    )?.[0];
    expect(statusFunction).toBeDefined();
    const serialized = runInNewContext(`
      ${statusFunction}
      const updates = [];
      function setConnection(message, tone) { updates.push({ message, tone }); }
      const sessionToken = "token";
      let liveUpdateState = "unavailable";
      let liveUpdateEpoch = 0;
      let liveStateEpoch = -1;
      let stateLoadStatus = "loading";

      renderConnectionStatus();
      stateLoadStatus = "available";
      renderConnectionStatus();

      liveUpdateState = "open";
      liveUpdateEpoch = 1;
      renderConnectionStatus();
      liveStateEpoch = liveUpdateEpoch;
      renderConnectionStatus();

      liveUpdateState = "reconnecting";
      liveUpdateEpoch += 1;
      stateLoadStatus = "loading";
      renderConnectionStatus();
      stateLoadStatus = "available";
      renderConnectionStatus();
      JSON.stringify(updates);
    `) as string;

    expect(JSON.parse(serialized)).toEqual([
      { message: "Live updates unavailable", tone: "unavailable" },
      { message: "Live updates unavailable", tone: "unavailable" },
      { message: "Refreshing local state", tone: "unavailable" },
      { message: "Live local state", tone: "present" },
      { message: "Reconnecting", tone: "unavailable" },
      { message: "Reconnecting", tone: "unavailable" }
    ]);
  });

  it("lets only the newest overlapping state request update the live view", () => {
    expect(COCKPIT_JAVASCRIPT).toContain("let stateRequestEpoch = 0;");
    expect(COCKPIT_JAVASCRIPT).toContain("const requestEpoch = ++stateRequestEpoch;");
    expect(
      COCKPIT_JAVASCRIPT.match(/if \(requestEpoch !== stateRequestEpoch\) return;/gu)
        ?.length
    ).toBeGreaterThanOrEqual(4);
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /if \(requestEpoch !== stateRequestEpoch\) return;\s*if \(!candidate \|\| candidate\.apiVersion !== supportedApiVersion\)/u
    );
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /if \(!candidate \|\| candidate\.apiVersion !== supportedApiVersion\)[\s\S]*?currentState = candidate;\s*stateLoadStatus = "available";\s*if \(liveUpdateState === "open" && expectedLiveEpoch === liveUpdateEpoch\) \{\s*liveStateEpoch = expectedLiveEpoch;\s*\}\s*renderConnectionStatus\(\);/u
    );
  });

  it("loads Runs pagination through authenticated same-origin reads", () => {
    expect(COCKPIT_JAVASCRIPT).toContain('const runsPath = "/api/runs";');
    expect(COCKPIT_JAVASCRIPT).toContain("const runsPageLimit = 64;");
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /new URLSearchParams\(\{\s*offset: String\([^)]*\),\s*limit: String\(runsPageLimit\)\s*\}\)/u
    );
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /fetch\(sameOriginUrl\([^)]*runs[^)]*\), \{\s*method: "GET",\s*headers: authenticatedHeaders\(\),\s*credentials: "same-origin",\s*cache: "no-store",\s*redirect: "error"\s*\}\)/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain("runsVisitedOffsets.push(");
    expect(COCKPIT_JAVASCRIPT).toContain("runsVisitedOffsets.pop()");
    expect(COCKPIT_JAVASCRIPT).toContain("page.nextOffset");
  });

  it.each([
    { total: 10, expectedOffsets: [0], expectedRequest: 0 },
    { total: 128, expectedOffsets: [0, 64], expectedRequest: 64 }
  ])(
    "recovers an invalidated Runs cursor against a shrunken total of $total",
    ({ total, expectedOffsets, expectedRequest }) => {
      const match = COCKPIT_JAVASCRIPT.match(
        /function isTerminalRunsCursorInvalidation\(candidate\) \{[\s\S]*?\n\}\n\nfunction recoverInvalidRunsCursor\(page\) \{[\s\S]*?\n\}/u
      );
      expect(match?.[0]).toBeDefined();
      const result = runInNewContext(
        `
          ${match?.[0]}
          let runsVisitedOffsets = [0, 64, 128];
          let resetCount = 0;
          const requestedOffsets = [];
          function resetRunTail() { resetCount += 1; }
          function loadRunsPage(offset) { requestedOffsets.push(offset); }
          const recovered = recoverInvalidRunsCursor(page);
          JSON.stringify({ recovered, runsVisitedOffsets, resetCount, requestedOffsets });
        `,
        {
          page: { offset: 128, limit: 64, total, nextOffset: null, runs: [] }
        }
      ) as string;

      expect(JSON.parse(result)).toEqual({
        recovered: true,
        runsVisitedOffsets: expectedOffsets,
        resetCount: 1,
        requestedOffsets: [expectedRequest]
      });
      expect(COCKPIT_JAVASCRIPT).toContain("if (recoverInvalidRunsCursor(candidate)) return;");
    }
  );

  it("validates the complete versioned Runs and error envelopes before rendering", () => {
    expect(COCKPIT_JAVASCRIPT).toContain('candidate.kind !== "runs-page"');
    expect(COCKPIT_JAVASCRIPT).toContain('candidate.apiVersion !== supportedApiVersion');
    expect(COCKPIT_JAVASCRIPT).toContain(
      'candidate.sourcePath !== ".visp/runs/index.json"'
    );
    for (const field of ["offset", "limit", "total", "nextOffset"]) {
      expect(COCKPIT_JAVASCRIPT, field).toContain(`candidate.${field}`);
    }
    expect(COCKPIT_JAVASCRIPT).toContain("Number.isSafeInteger");
    expect(COCKPIT_JAVASCRIPT).toContain("isSafeRunId");
    expect(COCKPIT_JAVASCRIPT).toContain("run.startedAt");

    expect(COCKPIT_JAVASCRIPT).toContain('candidate.kind !== "error"');
    expect(COCKPIT_JAVASCRIPT).toContain("validApiErrorCodes.has(candidate.error.code)");
    expect(COCKPIT_JAVASCRIPT).toContain("candidate.error.message.length > 512");
    expect(COCKPIT_JAVASCRIPT).toContain("function validApiError(candidate, expectedPath)");
    expect(COCKPIT_JAVASCRIPT).toContain(
      "candidate.error.artifact.expectedPath !== expectedPath"
    );
    expect(COCKPIT_JAVASCRIPT).toContain(
      "candidate.error.artifact.sourcePath !== undefined && candidate.error.artifact.sourcePath !== expectedPath"
    );
    expect(COCKPIT_JAVASCRIPT).toContain("validApiError(candidate, fallbackPath)");
  });

  it("rejects non-advancing or empty nonterminal Runs pages", () => {
    const terminalSource = COCKPIT_JAVASCRIPT.match(
      /function isTerminalRunsCursorInvalidation\(candidate\) \{[\s\S]*?\n\}/u
    )?.[0];
    const validatorSource = COCKPIT_JAVASCRIPT.match(
      /function validRunsPage\(candidate, requestedOffset\) \{[\s\S]*?\n\}/u
    )?.[0];
    expect(terminalSource).toBeDefined();
    expect(validatorSource).toBeDefined();
    const serialized = runInNewContext(`
      ${terminalSource}
      ${validatorSource}
      const supportedApiVersion = "1.0";
      function isSafeRunId(value) { return typeof value === "string" && value.length > 0; }
      function hasText(value) { return typeof value === "string" && value.length > 0; }
      const base = {
        apiVersion: "1.0",
        kind: "runs-page",
        sourcePath: ".visp/runs/index.json",
        offset: 0,
        limit: 64,
        total: 1
      };
      JSON.stringify({
        valid: validRunsPage({ ...base, runs: [{ id: "run-1", startedAt: "now" }], nextOffset: null }, 0),
        nonAdvancing: validRunsPage({ ...base, runs: [], nextOffset: 0 }, 0),
        emptyNonterminal: validRunsPage({ ...base, runs: [], nextOffset: null }, 0),
        shrunkenTerminal: validRunsPage({ ...base, offset: 128, total: 10, runs: [], nextOffset: null }, 128)
      });
    `) as string;

    expect(JSON.parse(serialized)).toEqual({
      valid: true,
      nonAdvancing: false,
      emptyNonterminal: false,
      shrunkenTerminal: true
    });
  });

  it("continues run-event tails with byte offset and generation", () => {
    expect(COCKPIT_JAVASCRIPT).toContain('url.searchParams.set("offset", String(runTailOffset));');
    expect(COCKPIT_JAVASCRIPT).toContain(
      'url.searchParams.set("generation", runTailGeneration);'
    );
    expect(COCKPIT_JAVASCRIPT).toContain('candidate.kind !== "run-events-page"');
    expect(COCKPIT_JAVASCRIPT).toContain("candidate.runId !== selectedRunId");
    expect(COCKPIT_JAVASCRIPT).toContain(
      'candidate.sourcePath !== ".visp/runs/" + selectedRunId + "/events.jsonl"'
    );
    expect(COCKPIT_JAVASCRIPT).toContain("event.runId !== selectedRunId");
    expect(COCKPIT_JAVASCRIPT).toContain("candidate.nextOffset");
    expect(COCKPIT_JAVASCRIPT).toContain("candidate.rotated");
    expect(COCKPIT_JAVASCRIPT).toContain("candidate.generation");
    expect(COCKPIT_JAVASCRIPT).toContain("appendBoundedRunEvents(page.events);");
    expect(COCKPIT_JAVASCRIPT).toContain("runTailOffset = page.nextOffset;");
    expect(COCKPIT_JAVASCRIPT).toContain("runTailGeneration = page.generation;");
  });

  it("accepts an advanced server-authenticated generation and rejects cursor/event mismatches", () => {
    const validatorSource = COCKPIT_JAVASCRIPT.match(
      /function validRunEventsPage\(candidate, requestedOffset\) \{[\s\S]*?\n\}/u
    )?.[0];
    expect(validatorSource).toBeDefined();
    const serialized = runInNewContext(`
      ${validatorSource}
      const supportedApiVersion = "1.0";
      const selectedRunId = "run-1";
      function hasText(value) { return typeof value === "string" && value.length > 0; }
      const base = {
        apiVersion: "1.0",
        kind: "run-events-page",
        runId: selectedRunId,
        sourcePath: ".visp/runs/run-1/events.jsonl",
        offset: 10,
        rotated: false,
        generation: "generation-at-next-offset"
      };
      JSON.stringify({
        appended: validRunEventsPage({ ...base, events: [{ runId: selectedRunId }], nextOffset: 20 }, 10),
        skippedBytes: validRunEventsPage({ ...base, events: [], nextOffset: 20 }, 10),
        duplicateEvents: validRunEventsPage({ ...base, events: [{ runId: selectedRunId }], nextOffset: 10 }, 10)
      });
    `) as string;

    expect(JSON.parse(serialized)).toEqual({
      appended: true,
      skippedBytes: false,
      duplicateEvents: false
    });
    expect(COCKPIT_JAVASCRIPT).not.toContain(
      "candidate.generation !== requestedGeneration"
    );
  });

  it("bounds the accumulated run-event display by record count and serialized UTF-8 bytes", () => {
    expect(COCKPIT_JAVASCRIPT).toContain("const runTailMaxRecords = 256;");
    expect(COCKPIT_JAVASCRIPT).toContain("const runTailMaxBytes = 2 * 1024 * 1024;");
    expect(COCKPIT_JAVASCRIPT).toContain("const runTailTextEncoder = new TextEncoder();");
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /function appendBoundedRunEvents\(events\)\s*\{[\s\S]*?runTailEvents\.push\(event\);[\s\S]*?runTailBytes \+= runTailTextEncoder\.encode\(JSON\.stringify\(event, null, 2\)\)\.byteLength;[\s\S]*?while \(runTailEvents\.length > runTailMaxRecords \|\| runTailBytes > runTailMaxBytes\) \{[\s\S]*?runTailEvents\.shift\(\);[\s\S]*?runTailBytes -= runTailTextEncoder\.encode\(JSON\.stringify\(removed, null, 2\)\)\.byteLength;[\s\S]*?runTailOmittedCount = Math\.min\(Number\.MAX_SAFE_INTEGER, runTailOmittedCount \+ 1\);[\s\S]*?\n\}/u
    );
    expect(COCKPIT_JAVASCRIPT).toContain("if (runTailOmittedCount > 0)");
    expect(COCKPIT_JAVASCRIPT).toContain("String(runTailOmittedCount)");
    expect(COCKPIT_JAVASCRIPT).toContain(
      "earlier or oversized event record(s) are omitted from this bounded display. The source artifact is unchanged."
    );
  });

  it("resets every accumulated run-event bound on rotation and run selection", () => {
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /if \(page\.rotated\) \{\s*runTailEvents = \[\];\s*runTailBytes = 0;\s*runTailOmittedCount = 0;\s*\}/u
    );
    expect(COCKPIT_JAVASCRIPT).toMatch(
      /function selectRun\(runId\) \{[\s\S]*?selectedRunId = runId;\s*runTailEvents = \[\];\s*runTailBytes = 0;\s*runTailOmittedCount = 0;\s*runTailOffset = 0;\s*runTailGeneration = "";/u
    );
  });

  it("renders all API-supplied Runs content as text and never as executable markup", () => {
    expect(COCKPIT_JAVASCRIPT).toContain("JSON.stringify(value, null, 2)");
    expect(COCKPIT_JAVASCRIPT).toContain('item.append(jsonBlock(event, "run-event-json"));');
    expect(COCKPIT_JAVASCRIPT).not.toMatch(
      /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/u
    );
    expect(COCKPIT_JAVASCRIPT).not.toMatch(
      /\b(?:exec|execFile|spawn|system|eval)\s*\(|new\s+Function\s*\(|child_process/u
    );
  });
});
