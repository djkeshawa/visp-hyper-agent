/**
 * DOM construction helpers, artifact and degraded-state rendering, and the
 * validators that refuse an artifact the state contract did not promise.
 *
 * One fragment of the Cockpit client program. The fragments are concatenated
 * in a fixed order by `client-script.ts` — see that file for why the order is
 * what it is. Keep this text free of backticks and of ${...}, which would be
 * read as template syntax rather than shipped to the browser.
 */


export const COCKPIT_CLIENT_ARTIFACTS = String.raw`
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
}`;
