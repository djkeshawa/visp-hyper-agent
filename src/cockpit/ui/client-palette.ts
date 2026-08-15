/**
 * The command palette, the global event wiring, and the bootstrap calls.
 * This fragment runs last because its final lines start the program.
 *
 * One fragment of the Cockpit client program. The fragments are concatenated
 * in a fixed order by `client-script.ts` — see that file for why the order is
 * what it is. Keep this text free of backticks and of ${...}, which would be
 * read as template syntax rather than shipped to the browser.
 */


export const COCKPIT_CLIENT_PALETTE = String.raw`
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
void loadState();`;
