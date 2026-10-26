import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/600.css";
import "@xterm/xterm/css/xterm.css";
import "./tokens.css";
import "./styles.css";

import {
  currentRecording,
  listRecordings,
  loadRecordingAvailability,
  markRecording,
  readRecording,
  recordingAvailable,
  type ReplaySpeed,
  type ReplayTarget,
} from "./recording";
import { CloseGuard } from "./close-guard";
import { isToolsShortcut } from "./keys";
import { chooseWorkArea, clickAction, findProject, keepSelection, nextSelection } from "./project-selection";
import {
  addProject,
  closeTab as forgetTab,
  listProjects,
  openTab as saveNewTab,
  relocateProject,
  rememberActiveTab,
  rememberSelection,
  removeProject,
  setProjectMarker,
  type Project,
} from "./projects";
import type { SpawnMode } from "./pty";
import { ReplayDeck, type LoadedReplay } from "./replay-deck";
import { fillTexts, messages, texts } from "./strings";
import { closeWarning, NO_WARNING, warningText as shownWarning, type WarningState } from "./warning-bar";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { runningSessions, UpdateFlow, type UpdateNotice } from "./updates";
import { ReplayPane, TabPane } from "./tab-pane";
import { afterRefusedStart, TabModel, type Tab, type TabState } from "./tabs";
import { markerIcon, outlineDrawing } from "./marker-icons";
import { markerColorValue, markerLook, projectInitials } from "./project-marker";
import {
  COLOR_CHOICES,
  currentSymbol,
  GRID_COLUMNS,
  gridMove,
  tabWrap,
  isMenuKey,
  symbolChoices,
  TRASH_PATH,
} from "./project-menu";
import {
  isRenderer,
  isUnicodeVersion,
  loadTerminalFonts,
  showRenderer,
  type TerminalView,
} from "./terminal-view";

/** Returns the element with `id`, or throws when the page lacks it. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`missing element #${id}`);
  }
  return found;
}

fillTexts(document);

const warningBar = element("warning", HTMLDivElement);
const warningText = element("warning-text", HTMLSpanElement);
const warningClose = element("warning-close", HTMLButtonElement);
const projectList = element("project-list", HTMLUListElement);
const addProjectButton = element("add-project", HTMLButtonElement);
const updateNotice = element("update-notice", HTMLDivElement);
const updateCompact = element("update-compact", HTMLButtonElement);
const emptyState = element("empty-state", HTMLElement);
const emptyOpenButton = element("empty-open", HTMLButtonElement);
const missingState = element("missing-state", HTMLElement);
const missingPath = element("missing-path", HTMLParagraphElement);
const relocateButton = element("relocate", HTMLButtonElement);
const removeButton = element("remove", HTMLButtonElement);
const noSessionState = element("no-session-state", HTMLElement);
const noSessionTitle = element("no-session-title", HTMLHeadingElement);
const noSessionPath = element("no-session-path", HTMLSpanElement);
const noSessionStartButton = element("no-session-start", HTMLButtonElement);
const tabBar = element("tab-bar", HTMLDivElement);
const tabList = element("tab-list", HTMLDivElement);
const newTabButton = element("new-tab", HTMLButtonElement);
const cwdText = element("cwd", HTMLSpanElement);
const controls = element("controls", HTMLElement);
const terminals = element("terminals", HTMLDivElement);
const rendererSelect = element("renderer", HTMLSelectElement);
const unicodeSelect = element("unicode", HTMLSelectElement);
const markButton = element("mark", HTMLButtonElement);
const recordingText = element("recording", HTMLSpanElement);
const recordingsSelect = element("recordings", HTMLSelectElement);
const speedSelect = element("replay-speed", HTMLSelectElement);
const replayButton = element("replay", HTMLButtonElement);
const nextMarkButton = element("next-mark", HTMLButtonElement);
const stopReplayButton = element("stop-replay", HTMLButtonElement);
const statusText = element("status", HTMLSpanElement);

/** The tabs of every project. */
const tabs = new TabModel();
/** The session count element of each project in the rail, by project id. */
const sessionCounts = new Map<number, HTMLSpanElement>();
/** The terminal of each open tab, by tab id: a session pane or the replay pane. */
const panes = new Map<number, TabPane | ReplayPane>();
/** The projects as last listed by Rust. */
let projects: readonly Project[] = [];
/** The id of the selected project, if any. */
let selectedId: number | undefined;
/** How many project selections have started; the latest one is the only one that acts. */
let selectionCount = 0;
/** What the warning bar has to show. */
let warning: WarningState = NO_WARNING;
/** The pane of the replay tab, the only one, while it is open. */
let replayPane: ReplayPane | undefined;
/** The open marker menu and the project button it opened from, while one is open. */
let markerMenu: { element: HTMLDivElement; anchor: HTMLButtonElement } | undefined;
/** The open remove dialog, its dimmed backdrop, and the project it removes, while one is open. */
let removeDialog: { element: HTMLDivElement; projectId: number } | undefined;
/** The open update dialog, the element it opened from, and how it answers the update flow, while one is open. */
let updateDialog: { element: HTMLDivElement; opener: HTMLElement; answer: (confirmed: boolean) => void } | undefined;
/** The ids of the session tabs the last install stopped while they ran or started. */
let stoppedForUpdate: number[] = [];
/** Keeps a double click on a close button from closing the next tab too. */
const closeGuard = new CloseGuard();
/** The ids of the projects whose new tab Rust is still creating. */
const opening = new Set<number>();
/** Settles once the terminal fonts are loaded, or failed to load; a terminal opened before would measure the fallback font. */
const fontsReady = loadTerminalFonts();
/** The update offered at startup, from the notice to the install. */
const updateFlow = new UpdateFlow({
  check: () => checkForUpdate(),
  confirmInstall: openUpdateDialog,
  stopSessions: stopAllSessions,
  sessionsStopped: offerStoppedSessions,
  show: renderUpdate,
});

/** Returns the active tab of the selected project, if any. */
function activeTab(): Tab | undefined {
  return selectedId === undefined ? undefined : tabs.activeOf(selectedId);
}

/** Returns the pane of the selected project's active tab, if any. */
function activePane(): TabPane | ReplayPane | undefined {
  const tab = activeTab();
  return tab ? panes.get(tab.id) : undefined;
}

/** The terminal a replay draws into: the replay tab's, while it is open. */
function replayView(): TerminalView | undefined {
  return replayPane?.view;
}

/** The xterm.js terminal, as a replay draws into it. */
const replayTarget: ReplayTarget = {
  reset: () => {
    replayView()?.terminal.reset();
  },
  resize: (cols, rows) => {
    replayView()?.terminal.resize(cols, rows);
  },
  write: (data) => {
    replayView()?.terminal.write(data);
  },
  drained: () =>
    new Promise((resolve) => {
      const view = replayView();
      if (view) {
        view.terminal.write("", resolve);
      } else {
        resolve();
      }
    }),
};

/** The replay on screen; loads, session starts and stops take their turn through it. */
const deck = new ReplayDeck(replayTarget, {
  read: readRecording,
  hold: () => {
    if (replayPane) {
      replayPane.view.autoFit = false;
    }
  },
  release: () => {
    replayPane?.view.clearAndFit();
  },
});

/** Shows a short message on the status line of the developer tools, seen only while they are shown. */
function showStatus(message: string): void {
  statusText.textContent = message;
}

/** Sets what the warning bar has to show, then draws it. */
function setWarning(state: WarningState): void {
  warning = state;
  const shown = shownWarning(warning);
  warningText.textContent = shown ?? "";
  warningBar.hidden = shown === undefined;
}

/** Shows `error` in the warning bar until the user closes it, even after the user closed the load warning. */
function showError(error: unknown): void {
  setWarning({ ...warning, actionError: String(error) });
}

/**
 * Shows the recording indicator with `text`, or hides it when `text` is
 * `undefined` or the build records nothing.
 */
function showRecording(text: string | undefined): void {
  recordingText.hidden = text === undefined || !recordingAvailable();
  recordingText.textContent = text ?? "";
}

/** Reloads the list of recordings, keeping the current choice when it is still there. */
async function refreshRecordings(): Promise<void> {
  const chosen = recordingsSelect.value;
  const recordings = await listRecordings();
  recordingsSelect.replaceChildren(
    ...recordings.map((recording) => {
      const kilobytes = Math.ceil(recording.size / 1024);
      return new Option(messages.recordingEntry(recording.name, kilobytes), recording.name);
    }),
  );
  if (recordings.some((recording) => recording.name === chosen)) {
    recordingsSelect.value = chosen;
  }
}

/**
 * Reloads the list of recordings, showing a failure on the developer tools'
 * status line. Does nothing when the build records nothing.
 */
function refreshRecordingsOrReport(): void {
  if (!recordingAvailable()) {
    return;
  }
  refreshRecordings().catch((error: unknown) => {
    showStatus(String(error));
  });
}

/** Builds the tab bar entry of `tab`: its label, which activates it, and its close button. */
function tabElement(tab: Tab, active: boolean): HTMLDivElement {
  const item = document.createElement("div");
  item.className = `tab ${tab.kind === "session" ? tab.state : "replay"}`;
  item.classList.toggle("active", active);
  item.setAttribute("role", "tab");
  item.setAttribute("aria-selected", String(active));
  const label = document.createElement("button");
  label.type = "button";
  label.className = "tab-label";
  label.textContent = tab.label;
  label.title = tab.kind === "session" ? messages.tabTitle(tab.label, tab.state) : tab.label;
  label.addEventListener("click", () => {
    activateTab(tab.id);
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.textContent = "×";
  close.setAttribute("aria-label", messages.closeTab(tab.label));
  close.addEventListener("click", () => {
    if (closeGuard.accept(performance.now())) {
      report(() => closeTab(tab.id, true));
    }
  });
  item.append(label, close);
  return item;
}

/**
 * Draws the work area: the empty, missing-folder or no-session state, or the
 * selected project's tab bar with its active tab's terminal shown on the
 * renderer the picker names. Every other terminal is hidden, on the DOM
 * renderer, its session left running.
 */
function renderTabs(): void {
  const hasTabs = selectedId !== undefined && tabs.tabsOf(selectedId).length > 0;
  const area = chooseWorkArea(projects, selectedId, hasTabs);
  emptyState.hidden = area.kind !== "empty";
  missingState.hidden = area.kind !== "missing";
  missingPath.textContent = area.kind === "missing" ? area.project.path : "";
  noSessionState.hidden = area.kind !== "no-session";
  noSessionTitle.textContent = area.kind === "no-session" ? messages.noSessionTitle(area.project.name) : "";
  noSessionPath.textContent = area.kind === "no-session" ? area.project.path : "";
  const project = area.kind === "terminal" ? findProject(projects, selectedId) : undefined;
  const active = project ? tabs.activeOf(project.id) : undefined;
  tabBar.hidden = project === undefined;
  cwdText.textContent = project?.path ?? "";
  cwdText.title = project?.path ?? "";
  tabList.replaceChildren(...(project ? tabs.tabsOf(project.id) : []).map((tab) => tabElement(tab, tab === active)));
  tabList.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  let shown: TabPane | ReplayPane | undefined;
  for (const [id, pane] of panes) {
    if (id === active?.id) {
      shown = pane;
    } else {
      pane.hide();
    }
  }
  if (shown) {
    shown.show();
    const wanted = rendererSelect.value;
    showRenderer(shown.view, isRenderer(wanted) ? wanted : "webgl", rendererSelect, showStatus);
  }
  showRecording(shown instanceof TabPane ? shown.recording : undefined);
  renderSessionCounts();
}

/**
 * Makes tab `tabId` its project's active tab, shows it and gives it the keyboard.
 * A session tab is also remembered by Rust as its project's active tab, for the next run.
 */
function activateTab(tabId: number): void {
  tabs.activate(tabId);
  renderTabs();
  panes.get(tabId)?.view.terminal.focus();
  if (tabId > 0) {
    report(() => rememberActiveTab(tabId));
  }
}

/** Gives `pane` the width table the control shows and registers it under its tab id. */
function registerPane(pane: TabPane | ReplayPane): void {
  const unicode = unicodeSelect.value;
  if (isUnicodeVersion(unicode)) {
    pane.view.setUnicodeVersion(unicode);
  }
  panes.set(pane.tabId, pane);
}

/** Creates the pane of session tab `tabId`, with the width table the control shows. */
function createPane(tabId: number): TabPane {
  const pane = new TabPane(terminals, tabId, {
    onExit: () => {
      tabs.setState(tabId, "exited");
      pane.recording = undefined;
      renderTabs();
      refreshRecordingsOrReport();
    },
    onError: (error) => {
      showError(error);
    },
    onMarkKey: () => {
      report(mark);
    },
    onRestart: () => {
      report(() => restartTab(tabId, "new"));
    },
    onResume: () => {
      report(() => restartTab(tabId, "resume"));
    },
    onClose: () => {
      report(() => closeTab(tabId, true));
    },
    onRetry: (mode) => {
      report(() => restartTab(tabId, mode));
    },
  });
  registerPane(pane);
  return pane;
}

/**
 * Starts `claude` in `mode` for session tab `tabId`, whose project folder is
 * `folder`. Resolves with whether the session started; a start Rust refuses
 * puts the tab in the `"failed"` state, its pane showing the refusal.
 */
async function startTab(tabId: number, mode: SpawnMode, folder: string): Promise<boolean> {
  const pane = panes.get(tabId);
  if (!(pane instanceof TabPane)) {
    return false;
  }
  let running: boolean;
  try {
    running = await pane.start(mode, folder);
  } catch {
    tabs.setState(tabId, "failed");
    renderTabs();
    return false;
  }
  const session = pane.slot.current;
  if (running && session) {
    const tab = tabs.find(tabId);
    if (tab?.kind === "session" && tab.state === "starting") {
      tabs.setState(tabId, "running");
    }
    renderTabs();
    if (pane === activePane()) {
      pane.view.terminal.focus();
    }
    const name = await currentRecording(session);
    if (recordingAvailable() && pane.slot.current === session) {
      pane.recording = name === null ? texts.notRecorded : messages.recordingName(name);
      if (pane === activePane()) {
        showRecording(pane.recording);
      }
    }
    refreshRecordingsOrReport();
  }
  return running;
}

/** Returns the state of session tab `tabId`, or `undefined` when it is gone or a replay tab. */
function sessionState(tabId: number): TabState | undefined {
  const tab = tabs.find(tabId);
  return tab?.kind === "session" ? tab.state : undefined;
}

/**
 * Opens a tab in `project`, saved by Rust, and starts a new session in it,
 * once the terminal fonts are loaded. A start Rust refuses leaves the tab
 * showing the refusal and reloads the projects, closing the project's tabs
 * when its folder is gone.
 */
async function openTab(project: Project): Promise<void> {
  await fontsReady;
  opening.add(project.id);
  let saved;
  try {
    saved = await saveNewTab(project.id);
  } finally {
    opening.delete(project.id);
  }
  const tab = tabs.open(project.id, saved.id);
  createPane(tab.id);
  renderTabs();
  if (await startTab(tab.id, "new", project.path)) {
    return;
  }
  if (afterRefusedStart(sessionState(tab.id), undefined) === "close") {
    await closeTab(tab.id, true);
  }
  await reloadAfterRefusal(project.id);
}

/**
 * Reopens the saved tabs of `project` from a previous run, each offering
 * Resume and New session, without starting any session.
 */
function restoreTabs(project: Project): void {
  const ids = project.tabs.map(({ id }) => id);
  for (const tab of tabs.restore(project.id, ids, project.activeTab ?? undefined)) {
    createPane(tab.id).showOffer("resume");
  }
}

/** Loads the projects and reopens the saved tabs of every project, at startup. */
async function restoreAllTabs(): Promise<void> {
  await refreshProjects();
  for (const project of projects) {
    restoreTabs(project);
  }
  renderTabs();
}

/**
 * Starts a session in `mode` in session tab `tabId`, restored or ended, on a
 * cleared screen. A start Rust refuses leaves the tab showing the refusal and
 * reloads the projects, closing every tab of the project when its folder is
 * gone; a start overtaken by another start or a stop puts the tab back in its
 * previous state.
 */
async function restartTab(tabId: number, mode: SpawnMode): Promise<void> {
  const tab = tabs.find(tabId);
  const project = tab ? findProject(projects, tab.projectId) : undefined;
  if (tab?.kind !== "session" || !project) {
    return;
  }
  const previous = tab.state;
  tabs.setState(tabId, "starting");
  renderTabs();
  if (await startTab(tabId, mode, project.path)) {
    return;
  }
  if (afterRefusedStart(sessionState(tabId), previous) === "restore") {
    tabs.setState(tabId, previous);
    renderTabs();
  }
  await reloadAfterRefusal(project.id);
}

/** Reloads the projects after a refused start; closes every tab of project `projectId` when its folder is gone. */
async function reloadAfterRefusal(projectId: number): Promise<void> {
  await refreshProjects();
  if (findProject(projects, projectId)?.exists === false) {
    await closeProjectTabs(projectId);
  }
}

/**
 * Closes tab `tabId`: stops its session or its replay, and disposes of its
 * terminal. A session tab is also removed from the saved tabs when `forget` is
 * set; otherwise Rust keeps it for the next run. When `forget` is set and the
 * tab now in front of the project is a session tab, Rust remembers it as the
 * project's active tab.
 */
async function closeTab(tabId: number, forget: boolean): Promise<void> {
  const pane = panes.get(tabId);
  if (!pane) {
    return;
  }
  panes.delete(tabId);
  const closed = tabs.close(tabId)?.closed;
  pane.hide();
  renderTabs();
  if (pane instanceof ReplayPane) {
    await deck.stop();
    if (replayPane === pane) {
      replayPane = undefined;
    }
    pane.close();
  } else {
    await pane.close();
    if (forget) {
      await forgetTab(tabId);
    }
  }
  const active = closed && tabs.activeOf(closed.projectId);
  if (forget && active?.kind === "session") {
    report(() => rememberActiveTab(active.id));
  }
  activePane()?.view.terminal.focus();
}

/** Closes every tab of project `projectId`, leaving its saved tabs to Rust. */
async function closeProjectTabs(projectId: number): Promise<void> {
  await Promise.all(tabs.tabsOf(projectId).map((tab) => closeTab(tab.id, false)));
}

/** Shows, next to each project in the rail, how many session tabs it has open; nothing for none. */
function renderSessionCounts(): void {
  for (const [projectId, count] of sessionCounts) {
    const open = tabs.tabsOf(projectId).filter((tab) => tab.kind === "session").length;
    count.textContent = open > 0 ? String(open) : "";
    count.title = messages.sessionCount(open);
  }
}

/**
 * Builds the marker square of `project`: its icon, or its initials, or the
 * fallback icon when its name has no letter, on its color, or on a dark ground
 * with a border when it has no color.
 */
function projectMarker(project: Project): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.className = "project-marker";
  marker.setAttribute("aria-hidden", "true");
  const look = markerLook(project.color, project.icon, project.name);
  if (look.ground === null) {
    marker.classList.add("no-color");
  } else {
    marker.style.backgroundColor = look.ground;
  }
  if (look.icon === null) {
    marker.textContent = look.initials;
  } else {
    marker.append(markerIcon(look.icon));
  }
  return marker;
}

/** Closes the marker menu, if one is open. */
function closeMarkerMenu(): void {
  const open = markerMenu;
  markerMenu = undefined;
  open?.element.remove();
}

/** Closes the marker menu, if one is open, and gives focus back to its project. */
function dismissMarkerMenu(): void {
  if (markerMenu !== undefined) {
    const { anchor } = markerMenu;
    closeMarkerMenu();
    anchor.focus();
  }
}

/** Returns the rail button of project `projectId`, or `null` when the rail does not list it. */
function projectButton(projectId: number): HTMLButtonElement | null {
  return projectList.querySelector<HTMLButtonElement>(`[data-project="${String(projectId)}"]`);
}

/**
 * A button of the marker menu showing `content`, named `label`, marked when
 * `current`; runs `pick` on click. It is out of the tab order until its grid
 * gives it the grid's tab stop.
 */
function markerChoice(label: string, current: boolean, content: Node | string, pick: () => void): HTMLButtonElement {
  const choice = document.createElement("button");
  choice.type = "button";
  choice.className = "marker-choice";
  choice.tabIndex = -1;
  choice.setAttribute("aria-label", label);
  choice.setAttribute("aria-pressed", String(current));
  choice.title = label;
  choice.append(content);
  choice.addEventListener("click", pick);
  return choice;
}

/**
 * A grid of the marker menu holding `choices`, named `label`, under a heading
 * that reads `label` and `current`, the name of the current choice. The grid
 * has a single tab stop: the current choice, else the first. The arrow keys,
 * Home and End move the focus between the choices.
 */
function markerGrid(label: string, current: string, choices: readonly HTMLButtonElement[]): HTMLDivElement {
  const heading = document.createElement("div");
  heading.className = "marker-heading";
  heading.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.textContent = label;
  const value = document.createElement("span");
  value.className = "marker-current";
  value.textContent = current;
  heading.append(name, value);
  const grid = document.createElement("div");
  grid.className = "marker-grid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", `${label}: ${current}`);
  grid.append(...choices);
  const start = choices.find((choice) => choice.getAttribute("aria-pressed") === "true") ?? choices[0];
  if (choices.length > 0) {
    start.tabIndex = 0;
  }
  grid.addEventListener("keydown", (event) => {
    const index = choices.findIndex((choice) => choice === event.target);
    const next = index < 0 ? undefined : gridMove(index, choices.length, GRID_COLUMNS, event.key);
    const target = choices.find((_, position) => position === next);
    if (!target) {
      return;
    }
    event.preventDefault();
    for (const choice of choices) {
      choice.tabIndex = -1;
    }
    target.tabIndex = 0;
    target.focus();
  });
  const block = document.createElement("div");
  block.className = "marker-block";
  block.append(heading, grid);
  return block;
}

/** The color grid of the marker menu of `project`: picking a color keeps the symbol. */
function colorGrid(project: Project): HTMLDivElement {
  const choices = COLOR_CHOICES.map((color) => {
    const swatch = document.createElement("span");
    swatch.className = "marker-swatch";
    if (color === null) {
      swatch.classList.add("no-color");
    } else {
      swatch.style.backgroundColor = markerColorValue(color);
    }
    const choice = markerChoice(messages.markerColorName(color), color === project.color, swatch, () => {
      report(() => chooseMarker(project.id, color, project.icon, "color"));
    });
    choice.classList.add("color-choice");
    return choice;
  });
  return markerGrid(texts.markerColors, messages.markerColorName(project.color), choices);
}

/**
 * The symbol grid of the marker menu of `project`, each symbol drawn on its
 * color: picking a symbol keeps the color.
 */
function symbolGrid(project: Project): HTMLDivElement {
  const current = currentSymbol(project.icon, project.name);
  const choices = symbolChoices(project.name).map((icon) => {
    const content = icon === null ? projectInitials(project.name) : markerIcon(icon);
    const choice = markerChoice(messages.markerSymbolName(icon), icon === current, content, () => {
      report(() => chooseMarker(project.id, project.color, icon, "symbol"));
    });
    choice.classList.add("symbol-choice");
    if (project.color === null) {
      choice.classList.add("no-color");
    } else {
      choice.style.backgroundColor = markerColorValue(project.color);
    }
    return choice;
  });
  return markerGrid(texts.markerSymbols, messages.markerSymbolName(current), choices);
}

/** The grid of the marker menu that takes the focus when it opens. */
type MarkerGridName = "color" | "symbol";

/**
 * Opens, under project button `anchor` and inside the window, the menu of
 * `project`: its color grid, its symbol grid, and an entry that asks to remove
 * the project. Focuses the current choice of grid `focus`; Tab and Shift+Tab
 * cycle inside the menu.
 */
function openMarkerMenu(project: Project, anchor: HTMLButtonElement, focus: MarkerGridName = "color"): void {
  closeMarkerMenu();
  const menu = document.createElement("div");
  menu.className = "marker-menu";
  menu.tabIndex = -1;
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", messages.markerMenu(project.name));
  const colors = colorGrid(project);
  const symbols = symbolGrid(project);
  const section = document.createElement("div");
  section.className = "marker-section";
  section.append(colors, symbols);
  const separator = document.createElement("div");
  separator.className = "marker-separator";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "marker-remove";
  remove.append(outlineDrawing(TRASH_PATH), texts.removeProjectEntry);
  remove.addEventListener("click", () => {
    closeMarkerMenu();
    openRemoveDialog(project);
  });
  menu.append(section, separator, remove);
  menu.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && menu.contains(event.relatedTarget))) {
      closeMarkerMenu();
    }
  });
  menu.addEventListener("keydown", (event) => {
    trapFocus(menu, event);
  });
  menu.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
  document.body.append(menu);
  placeMarkerMenu(menu, anchor);
  markerMenu = { element: menu, anchor };
  const focused = focus === "color" ? colors : symbols;
  focused.querySelector<HTMLButtonElement>(".marker-choice[tabindex='0']")?.focus();
}

/** Places marker menu `menu` under project button `anchor`, moved up and left as needed to stay inside the window. */
function placeMarkerMenu(menu: HTMLDivElement, anchor: HTMLButtonElement): void {
  const place = anchor.getBoundingClientRect();
  const top = Math.max(0, Math.min(place.bottom, window.innerHeight - menu.offsetHeight));
  const left = Math.max(0, Math.min(place.left, window.innerWidth - menu.offsetWidth));
  menu.style.left = `${String(left)}px`;
  menu.style.top = `${String(top)}px`;
}

/** Closes the remove dialog, if one is open, without moving the focus. */
function closeRemoveDialog(): void {
  const open = removeDialog;
  removeDialog = undefined;
  open?.element.remove();
}

/** Closes the remove dialog, if one is open, changing nothing, and gives focus back to its project. */
function dismissRemoveDialog(): void {
  if (removeDialog !== undefined) {
    const { projectId } = removeDialog;
    closeRemoveDialog();
    projectButton(projectId)?.focus();
  }
}

/**
 * Keeps Tab and Shift+Tab of keyboard event `event` inside `dialog`, cycling
 * through its enabled buttons that are in the tab order.
 */
function trapFocus(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") {
    return;
  }
  const stops = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter(
    (button) => button.tabIndex >= 0,
  );
  const index = stops.findIndex((stop) => stop === document.activeElement);
  const wrap = tabWrap(index, stops.length, event.shiftKey);
  if (stops.length === 0) {
    event.preventDefault();
  } else if (wrap !== undefined) {
    event.preventDefault();
    stops[wrap].focus();
  }
}

/**
 * Opens, over a dimmed window, the dialog that confirms the removal of
 * `project`: it says how many of its tabs close and that its folder stays on
 * disk, and focuses Cancel. Escape, Cancel or a click on the dimmed area
 * close it and change nothing.
 */
function openRemoveDialog(project: Project): void {
  closeRemoveDialog();
  const scrim = document.createElement("div");
  scrim.className = "dialog-scrim";
  const dialog = document.createElement("div");
  dialog.className = "remove-dialog";
  dialog.tabIndex = -1;
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "remove-title");
  dialog.setAttribute("aria-describedby", "remove-text");
  const title = document.createElement("h2");
  title.id = "remove-title";
  title.className = "remove-title";
  title.append(projectMarker(project), messages.removeTitle(project.name));
  const text = document.createElement("p");
  text.id = "remove-text";
  text.textContent = `${messages.removeTabs(tabs.tabsOf(project.id).length)} ${texts.folderStays}`;
  const path = document.createElement("p");
  path.className = "remove-path";
  path.textContent = project.path;
  const failure = document.createElement("p");
  failure.className = "remove-error";
  failure.setAttribute("role", "alert");
  failure.hidden = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = texts.cancel;
  cancel.addEventListener("click", dismissRemoveDialog);
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "danger";
  confirm.textContent = texts.confirmRemove;
  confirm.addEventListener("click", () => {
    report(() => confirmRemoval(project, { confirm, failure, details: [text, path] }));
  });
  const actions = document.createElement("div");
  actions.className = "remove-actions";
  actions.append(cancel, confirm);
  dialog.append(title, text, path, failure, actions);
  dialog.addEventListener("keydown", (event) => {
    trapFocus(dialog, event);
  });
  scrim.append(dialog);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) {
      dismissRemoveDialog();
    }
  });
  document.body.append(scrim);
  removeDialog = { element: scrim, projectId: project.id };
  cancel.focus();
}

/**
 * Removes `project` from the remove dialog. On success the dialog closes,
 * then the project's tabs close and the projects reload. A removal Rust
 * refuses changes nothing: the dialog stays open and shows the refusal in
 * `parts.failure` in place of `parts.details`, and `parts.confirm` becomes
 * Try again.
 */
async function confirmRemoval(
  project: Project,
  parts: { confirm: HTMLButtonElement; failure: HTMLElement; details: readonly HTMLElement[] },
): Promise<void> {
  parts.confirm.disabled = true;
  try {
    await dropProject(project);
  } catch (error: unknown) {
    parts.failure.textContent = messages.removeFailed(String(error));
    parts.failure.hidden = false;
    for (const detail of parts.details) {
      detail.hidden = true;
    }
    parts.confirm.textContent = texts.tryAgain;
    parts.confirm.disabled = false;
    parts.confirm.focus();
    return;
  }
  closeRemoveDialog();
  await afterRemoval(project.id);
  (projectList.querySelector<HTMLButtonElement>(".project.active") ?? addProjectButton).focus();
}

/** The path data of the update notice's arrow, a 24×24 outline like the marker icons. */
const UPDATE_PATH = "M12 19V5M5 12l7-7 7 7";
/** The path data of the warning drawing of a failed update. */
const WARNING_PATH = "M12 3 2 20h20zM12 10v4M12 17v.01";

/** Returns how many session tabs, of every project, run a session now. */
function runningSessionCount(): number {
  const states = projects.flatMap((project) =>
    tabs.tabsOf(project.id).flatMap((tab) => (tab.kind === "session" ? [tab.state] : [])),
  );
  return runningSessions(states);
}

/** Stops the session of every session tab, keeping the tabs saved for the next run, and records which tabs ran or started a session. */
async function stopAllSessions(): Promise<void> {
  stoppedForUpdate = projects.flatMap((project) =>
    tabs
      .tabsOf(project.id)
      .flatMap((tab) => (tab.kind === "session" && (tab.state === "running" || tab.state === "starting") ? [tab.id] : [])),
  );
  const stops = [...panes.values()].flatMap((pane) => (pane instanceof TabPane ? [pane.slot.stop()] : []));
  await Promise.all(stops);
}

/** Marks the tabs the last install stopped as exited, each offering Resume and New session. */
function offerStoppedSessions(): void {
  for (const tabId of stoppedForUpdate) {
    const pane = panes.get(tabId);
    if (pane instanceof TabPane) {
      tabs.setState(tabId, "exited");
      pane.recording = undefined;
      pane.showOffer("resume");
    }
  }
  stoppedForUpdate = [];
  renderTabs();
  refreshRecordingsOrReport();
}

/** The text under the title of update notice `notice`, which is not `"none"`. */
function updateDetail(notice: Exclude<UpdateNotice, { kind: "none" }>): string {
  switch (notice.kind) {
    case "available":
      return messages.updateCurrent(notice.current);
    case "downloading":
      return messages.downloadProgress(notice.received, notice.total);
    case "failed":
      switch (notice.reason) {
        case "signature":
          return texts.updateSignatureFailed;
        case "network":
          return texts.updateNetworkFailed;
        case "install":
          return texts.updateInstallFailed;
      }
  }
}

/** The title of update notice `notice`, which is not `"none"`. */
function updateTitle(notice: Exclude<UpdateNotice, { kind: "none" }>): string {
  switch (notice.kind) {
    case "available":
      return messages.updateAvailable(notice.version);
    case "downloading":
      return messages.downloadingUpdate(notice.version);
    case "failed":
      return texts.updateFailedTitle;
  }
}

/** Draws update notice `notice` in the rail, wide and narrow; `"none"` hides both. */
function renderUpdate(notice: UpdateNotice): void {
  updateNotice.replaceChildren();
  updateCompact.replaceChildren();
  updateNotice.hidden = notice.kind === "none";
  updateCompact.hidden = notice.kind === "none";
  if (notice.kind === "none") {
    return;
  }
  const failed = notice.kind === "failed";
  updateNotice.classList.toggle("failed", failed);
  updateCompact.classList.toggle("failed", failed);
  const icon = document.createElement("span");
  icon.className = "update-icon";
  icon.append(outlineDrawing(failed ? WARNING_PATH : UPDATE_PATH));
  const title = document.createElement("p");
  title.className = "update-title";
  title.textContent = updateTitle(notice);
  const detail = document.createElement("p");
  detail.className = "update-detail";
  detail.textContent = updateDetail(notice);
  const text = document.createElement("div");
  text.className = "update-text";
  text.append(title, detail);
  const head = document.createElement("div");
  head.className = "update-head";
  head.append(icon, text);
  if (notice.kind !== "downloading") {
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "update-hide";
    hide.textContent = "×";
    hide.setAttribute("aria-label", texts.updateHide);
    hide.title = texts.updateHide;
    hide.addEventListener("click", () => {
      updateFlow.dismiss();
      addProjectButton.focus();
    });
    head.append(hide);
  }
  updateNotice.append(head);
  if (notice.kind === "downloading") {
    const percent = notice.total ? Math.min(100, Math.round((notice.received / notice.total) * 100)) : 0;
    const bar = document.createElement("div");
    bar.className = "update-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", title.textContent);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percent));
    const fill = document.createElement("div");
    fill.className = "update-fill";
    fill.style.width = `${String(percent)}%`;
    bar.append(fill);
    updateNotice.append(bar);
  } else {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "update-action";
    action.textContent = failed ? texts.tryAgain : texts.installUpdate;
    action.addEventListener("click", () => {
      void updateFlow.install();
    });
    updateNotice.append(action);
  }
  const label =
    notice.kind === "available" ? messages.updateCompact(notice.version) : `${title.textContent}. ${detail.textContent}`;
  updateCompact.setAttribute("aria-label", label);
  updateCompact.title = label;
  updateCompact.setAttribute("aria-disabled", String(notice.kind === "downloading"));
  updateCompact.append(outlineDrawing(failed ? WARNING_PATH : UPDATE_PATH));
}

/** Closes the update dialog, if one is open, answering `confirmed` to the update flow, without moving the focus. */
function closeUpdateDialog(confirmed: boolean): void {
  const open = updateDialog;
  updateDialog = undefined;
  open?.element.remove();
  open?.answer(confirmed);
}

/** Closes the update dialog, if one is open, cancelling the install, and gives focus back to the element it opened from. */
function dismissUpdateDialog(): void {
  if (updateDialog !== undefined) {
    const { opener } = updateDialog;
    closeUpdateDialog(false);
    opener.focus();
  }
}

/**
 * Opens, over a dimmed window, the dialog that confirms the install of
 * `version`: it says the app restarts and how many running sessions stop
 * now, and focuses Cancel. Resolves `true` on Install and restart, which
 * gives focus to the active project or the add-project button. Resolves
 * `false` on Escape, Cancel or a click on the dimmed area, which give focus
 * back to the element focused at opening. Never rejects.
 */
function openUpdateDialog(version: string): Promise<boolean> {
  closeUpdateDialog(false);
  const focused = document.activeElement;
  const opener = focused instanceof HTMLElement && focused !== document.body ? focused : addProjectButton;
  const running = runningSessionCount();
  const scrim = document.createElement("div");
  scrim.className = "dialog-scrim";
  const dialog = document.createElement("div");
  dialog.className = "remove-dialog";
  dialog.tabIndex = -1;
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "update-dialog-title");
  dialog.setAttribute("aria-describedby", "update-dialog-text");
  const title = document.createElement("h2");
  title.id = "update-dialog-title";
  title.className = "remove-title";
  title.textContent = messages.installTitle(version);
  const text = document.createElement("p");
  text.id = "update-dialog-text";
  const sessions = document.createElement("strong");
  sessions.textContent = messages.updateSessions(running);
  text.append(`${texts.updateRestarts} `, sessions);
  if (running > 0) {
    text.append(` ${texts.updateTabsComeBack}`);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = texts.cancel;
  cancel.addEventListener("click", dismissUpdateDialog);
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "info";
  confirm.textContent = texts.installAndRestart;
  confirm.addEventListener("click", () => {
    closeUpdateDialog(true);
    (projectList.querySelector<HTMLButtonElement>(".project.active") ?? addProjectButton).focus();
  });
  const actions = document.createElement("div");
  actions.className = "remove-actions";
  actions.append(cancel, confirm);
  dialog.append(title, text, actions);
  dialog.addEventListener("keydown", (event) => {
    trapFocus(dialog, event);
  });
  scrim.append(dialog);
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) {
      dismissUpdateDialog();
    }
  });
  const answered = new Promise<boolean>((resolve) => {
    updateDialog = { element: scrim, opener, answer: resolve };
  });
  document.body.append(scrim);
  cancel.focus();
  return answered;
}

/**
 * Gives project `projectId` marker color `color`, `null` for no color, and
 * marker icon `icon`, `null` for the initials, then redraws the rail with the
 * project Rust returns and, when its menu is still open and no remove dialog
 * is, opens it again, focused on grid `grid`.
 */
async function chooseMarker(
  projectId: number,
  color: string | null,
  icon: string | null,
  grid: MarkerGridName,
): Promise<void> {
  const menu = markerMenu;
  const updated = await setProjectMarker(projectId, color, icon);
  const reopen = menu !== undefined && markerMenu === menu && removeDialog === undefined;
  projects = projects.map((project) => (project.id === updated.id ? updated : project));
  renderProjects();
  if (!reopen) {
    return;
  }
  const button = projectButton(projectId);
  if (button === null) {
    return;
  }
  openMarkerMenu(updated, button, grid);
}

/** Draws the project rail and the work area from `projects` and `selectedId`. */
function renderProjects(): void {
  closeMarkerMenu();
  sessionCounts.clear();
  projectList.replaceChildren(
    ...projects.map((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project";
      button.classList.toggle("active", project.id === selectedId);
      button.classList.toggle("missing", !project.exists);
      button.title = project.exists
        ? messages.projectTitle(project.name, project.path)
        : messages.missingProjectTitle(project.name, project.path);
      button.dataset.project = String(project.id);
      const marker = projectMarker(project);
      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = project.name;
      const path = document.createElement("span");
      path.className = "project-path";
      path.textContent = project.path;
      const text = document.createElement("span");
      text.className = "project-text";
      text.append(name, path);
      const count = document.createElement("span");
      count.className = "project-count";
      sessionCounts.set(project.id, count);
      button.append(marker, text, count);
      button.addEventListener("click", () => {
        report(() => selectProject(project.id));
      });
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openMarkerMenu(project, button);
      });
      button.addEventListener("keydown", (event) => {
        if (isMenuKey(event)) {
          event.preventDefault();
          openMarkerMenu(project, button);
        }
      });
      const item = document.createElement("li");
      item.append(button);
      return item;
    }),
  );
  renderTabs();
}

/**
 * Reloads the project list from Rust and redraws. Keeps the selection when it
 * is still there, else selects the project Rust gives, without opening a tab.
 */
async function refreshProjects(): Promise<void> {
  const list = await listProjects();
  projects = list.projects;
  selectedId = nextSelection(projects, selectedId, list.selected);
  setWarning({ ...warning, loadWarning: list.warning });
  renderProjects();
}

/**
 * Reloads the project list, then selects project `id` and has Rust remember
 * it: shows its active tab, or opens one when it has none. Selecting a project
 * whose folder is gone closes its tabs and shows the missing-folder state.
 * Other projects' sessions keep running. A selection overtaken by a later one
 * while the list reloads does nothing.
 */
async function selectProject(id: number): Promise<void> {
  selectionCount += 1;
  const selection = selectionCount;
  await refreshProjects();
  if (selection !== selectionCount) {
    return;
  }
  const action = clickAction(projects, id, tabs.tabsOf(id).length > 0 || opening.has(id));
  selectedId = keepSelection(projects, id);
  renderProjects();
  if (action.kind !== "none") {
    report(() => rememberSelection(id));
  }
  if (action.kind === "open") {
    await openTab(action.project);
  } else if (action.kind === "missing") {
    await closeProjectTabs(id);
  } else if (action.kind === "show") {
    activePane()?.view.terminal.focus();
  }
}

/** Opens a new tab in the selected project, when its folder exists. */
async function openTabInSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (selected?.exists) {
    await openTab(selected);
  }
}

/** Opens the folder picker, adds the chosen folder as a project and selects it. */
async function openFolder(): Promise<void> {
  const project = await addProject();
  if (project === null) {
    return;
  }
  await selectProject(project.id);
}

/**
 * Opens the folder picker to give the selected project a new folder, reopens
 * its saved tabs when it shows none, then selects it again.
 */
async function relocateSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  const moved = await relocateProject(selected.id);
  if (moved === null) {
    return;
  }
  if (tabs.tabsOf(moved.id).length === 0) {
    restoreTabs(moved);
  }
  await selectProject(moved.id);
}

/**
 * Has Rust remove `project` from its list, its folder left on disk. When it is
 * the selected project, it is stored as Rust's selection first, so the
 * neighbour Rust picks is the neighbour of the removed one. Rejects with Rust's
 * refusal; the project and its tabs are then unchanged.
 */
async function dropProject(project: Project): Promise<void> {
  if (project.id === selectedId) {
    await rememberSelection(project.id);
  }
  await removeProject(project.id);
}

/**
 * Closes the tabs of project `projectId`, which Rust has just removed, then
 * reloads the projects; when it was selected, selects the project Rust gives,
 * without opening a tab.
 */
async function afterRemoval(projectId: number): Promise<void> {
  if (selectedId === projectId) {
    selectedId = undefined;
  }
  await closeProjectTabs(projectId);
  await refreshProjects();
}

/** Removes the selected project and closes all its tabs, as {@link dropProject} and {@link afterRemoval} do. */
async function removeSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  await dropProject(selected);
  await afterRemoval(selected.id);
}

/**
 * Writes a marker in the recording of the active tab's session. Does nothing
 * on a replay tab, or when the build records nothing.
 */
async function mark(): Promise<void> {
  const pane = activePane();
  if (!recordingAvailable() || pane instanceof ReplayPane) {
    return;
  }
  const session = pane?.slot.current;
  if (!session) {
    showStatus(texts.noSessionToMark);
    return;
  }
  await markRecording(session);
  showStatus(messages.markedAt(new Date().toLocaleTimeString()));
}

/**
 * Shows the replay tab of `project`, labelled with recording `name`: reuses the
 * project's replay tab, else opens one, after closing the replay tab another
 * project holds. Waits for the terminal fonts first.
 */
async function showReplayTab(project: Project, name: string): Promise<void> {
  await fontsReady;
  const existing = tabs.replayTab();
  if (existing && existing.projectId !== project.id) {
    await closeTab(existing.id, false);
  }
  const tab = tabs.openReplay(project.id, name);
  const pane = panes.get(tab.id);
  if (pane instanceof ReplayPane) {
    replayPane = pane;
  } else {
    replayPane = new ReplayPane(terminals, tab.id);
    registerPane(replayPane);
  }
  renderTabs();
}

/**
 * Ends any replay, then loads the chosen recording on a replay of its own,
 * drawn in the selected project's replay tab. No session is touched. The grid
 * stops following its container until the replay ends.
 */
async function loadReplay(): Promise<LoadedReplay | undefined> {
  const name = recordingsSelect.value;
  if (name === "") {
    showStatus(texts.noRecordingChosen);
    return undefined;
  }
  const project = findProject(projects, selectedId);
  if (!project?.exists) {
    showStatus(texts.selectProjectToReplay);
    return undefined;
  }
  await showReplayTab(project, name);
  const { replay, truncated } = await deck.load(name);
  if (truncated) {
    showStatus(messages.truncatedRecording(name));
  }
  return replay;
}

/** Replays the chosen recording from its start, at the chosen speed. */
async function replayFromStart(): Promise<void> {
  const loaded = await loadReplay();
  if (!loaded) {
    return;
  }
  const speed: ReplaySpeed = speedSelect.value === "realtime" ? "realtime" : "instant";
  showStatus(messages.replaying(loaded.name));
  const stop = await deck.run(loaded, speed, false);
  if (stop === "end") {
    showStatus(messages.endOfRecording(loaded.name));
  }
}

/** Replays instantly up to the next marker of the chosen recording, then pauses there. */
async function replayToNextMark(): Promise<void> {
  const onScreen = deck.current;
  const shownTab = tabs.replayTab();
  const resumable =
    onScreen?.name === recordingsSelect.value &&
    !onScreen.player.finished &&
    shownTab !== undefined &&
    shownTab.projectId === selectedId;
  if (resumable) {
    activateTab(shownTab.id);
  }
  const current = resumable ? onScreen : await loadReplay();
  if (!current) {
    return;
  }
  const stop = await deck.run(current, "instant", true);
  if (stop === "marker") {
    current.marks += 1;
    showStatus(messages.pausedAtMarker(current.name, current.marks));
  } else if (stop === "end") {
    showStatus(messages.noMarkerLeft(current.name));
  }
}

/** Runs `action`, showing its failure in the warning bar. */
function report(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    showError(error);
  });
}

addProjectButton.addEventListener("click", () => {
  report(openFolder);
});

emptyOpenButton.addEventListener("click", () => {
  report(openFolder);
});

relocateButton.addEventListener("click", () => {
  report(relocateSelected);
});

removeButton.addEventListener("click", () => {
  report(removeSelected);
});

newTabButton.addEventListener("click", () => {
  report(openTabInSelected);
});

noSessionStartButton.addEventListener("click", () => {
  report(openTabInSelected);
});

warningClose.addEventListener("click", () => {
  setWarning(closeWarning(warning));
});

markButton.addEventListener("click", () => {
  report(mark);
  activePane()?.view.terminal.focus();
});

replayButton.addEventListener("click", () => {
  report(replayFromStart);
});

nextMarkButton.addEventListener("click", () => {
  report(replayToNextMark);
});

stopReplayButton.addEventListener("click", () => {
  report(async () => {
    if (await deck.stop()) {
      showStatus(texts.replayStopped);
    }
  });
});

rendererSelect.addEventListener("change", () => {
  const wanted = rendererSelect.value;
  const pane = activePane();
  if (isRenderer(wanted) && pane) {
    showRenderer(pane.view, wanted, rendererSelect, showStatus);
    pane.view.terminal.focus();
  }
});

unicodeSelect.addEventListener("change", () => {
  const wanted = unicodeSelect.value;
  if (isUnicodeVersion(wanted)) {
    for (const pane of panes.values()) {
      pane.view.setUnicodeVersion(wanted);
    }
    activePane()?.view.terminal.focus();
  }
});

updateCompact.addEventListener("click", () => {
  const { kind } = updateFlow.notice;
  if (kind === "available" || kind === "failed") {
    void updateFlow.install();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (updateDialog !== undefined) {
      dismissUpdateDialog();
    } else if (removeDialog === undefined) {
      dismissMarkerMenu();
    } else {
      dismissRemoveDialog();
    }
  }
});

document.addEventListener(
  "pointerdown",
  (event) => {
    if (markerMenu !== undefined && !(event.target instanceof Node && markerMenu.element.contains(event.target))) {
      closeMarkerMenu();
    }
  },
  { capture: true },
);

window.addEventListener("resize", dismissMarkerMenu);

window.addEventListener(
  "keydown",
  (event) => {
    if (!isToolsShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      controls.hidden = !controls.hidden;
    }
  },
  { capture: true },
);

const recordingControls = [
  markButton,
  recordingsSelect.closest("label") ?? recordingsSelect,
  speedSelect,
  replayButton,
  nextMarkButton,
  stopReplayButton,
];
for (const control of [...recordingControls, recordingText]) {
  control.hidden = true;
}
void loadRecordingAvailability().then((available) => {
  for (const control of recordingControls) {
    control.hidden = !available;
  }
  refreshRecordingsOrReport();
});
report(async () => {
  await fontsReady;
  await restoreAllTabs();
});
void updateFlow.checkAtStartup();
