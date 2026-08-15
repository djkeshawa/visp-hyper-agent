/**
 * The Runs browser: page validation and cursor recovery, plus the bounded
 * byte-offset tail over a single run's event artifact.
 *
 * One fragment of the Cockpit client program. The fragments are concatenated
 * in a fixed order by `client-script.ts` — see that file for why the order is
 * what it is. Keep this text free of backticks and of ${...}, which would be
 * read as template syntax rather than shipped to the browser.
 */


export const COCKPIT_CLIENT_RUNS = String.raw`
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
}`;
