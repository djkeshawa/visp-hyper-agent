/**
 * Screen rendering and navigation, the authenticated state fetch, and the
 * server-sent invalidation stream that schedules refreshes.
 *
 * One fragment of the Cockpit client program. The fragments are concatenated
 * in a fixed order by `client-script.ts` — see that file for why the order is
 * what it is. Keep this text free of backticks and of ${...}, which would be
 * read as template syntax rather than shipped to the browser.
 */


export const COCKPIT_CLIENT_SCREENS = String.raw`
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
}`;
