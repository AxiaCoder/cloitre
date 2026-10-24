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
import { ReplayPane, TabPane } from "./tab-pane";
import { afterRefusedStart, TabModel, type Tab, type TabState } from "./tabs";
import { markerIcon } from "./marker-icons";
import { FALLBACK_ICON, MARKER_COLORS, MARKER_ICONS, markerColorValue, projectInitials } from "./project-marker";
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
/** Keeps a double click on a close button from closing the next tab too. */
const closeGuard = new CloseGuard();
/** The ids of the projects whose new tab Rust is still creating. */
const opening = new Set<number>();
/** Settles once the terminal fonts are loaded, or failed to load; a terminal opened before would measure the fallback font. */
const fontsReady = loadTerminalFonts();

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
 * Builds the marker square of `project`: its icon on a plain square when it has
 * one, else its initials on its color, or the fallback icon when its name has
 * no letter.
 */
function projectMarker(project: Project): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.className = "project-marker";
  marker.setAttribute("aria-hidden", "true");
  if (project.icon !== null) {
    marker.classList.add("with-icon");
    marker.append(markerIcon(project.icon));
    return marker;
  }
  marker.style.backgroundColor = markerColorValue(project.color);
  const initials = projectInitials(project.name);
  if (initials === "") {
    marker.append(markerIcon(FALLBACK_ICON));
  } else {
    marker.textContent = initials;
  }
  return marker;
}

/** Closes the marker menu, if one is open. */
function closeMarkerMenu(): void {
  markerMenu?.element.remove();
  markerMenu = undefined;
}

/** A button of the marker menu showing `content`, named `label`, marked when `current`; runs `pick` on click. */
function markerChoice(label: string, current: boolean, content: Node | string, pick: () => void): HTMLButtonElement {
  const choice = document.createElement("button");
  choice.type = "button";
  choice.className = "marker-choice";
  choice.setAttribute("aria-label", label);
  choice.setAttribute("aria-pressed", String(current));
  choice.title = label;
  choice.append(content);
  choice.addEventListener("click", pick);
  return choice;
}

/** A titled group of the marker menu holding `choices`. */
function markerGroup(title: string, choices: readonly HTMLButtonElement[]): HTMLDivElement {
  const heading = document.createElement("span");
  heading.className = "marker-heading";
  heading.textContent = title;
  const grid = document.createElement("div");
  grid.className = "marker-grid";
  grid.setAttribute("role", "group");
  grid.setAttribute("aria-label", title);
  grid.append(...choices);
  const group = document.createElement("div");
  group.append(heading, grid);
  return group;
}

/**
 * Opens, under project button `anchor`, the menu that changes the marker of
 * `project`: its colors, its icons and a button back to the color marker.
 * Picking a color also drops the icon. Focuses the current choice.
 */
function openMarkerMenu(project: Project, anchor: HTMLButtonElement): void {
  closeMarkerMenu();
  const pick = (color: string, icon: string | null) => () => {
    report(() => chooseMarker(project.id, color, icon));
  };
  const colors = MARKER_COLORS.map((color) => {
    const swatch = document.createElement("span");
    swatch.className = "marker-swatch";
    swatch.style.backgroundColor = markerColorValue(color);
    return markerChoice(
      messages.markerColor(color),
      project.icon === null && color === project.color,
      swatch,
      pick(color, null),
    );
  });
  const icons = MARKER_ICONS.map((icon) =>
    markerChoice(messages.markerIcon(icon), icon === project.icon, markerIcon(icon), pick(project.color, icon)),
  );
  const noIcon = markerChoice(texts.noIcon, project.icon === null, texts.noIcon, pick(project.color, null));
  noIcon.classList.add("marker-no-icon");
  const menu = document.createElement("div");
  menu.className = "marker-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", messages.markerMenu(project.name));
  menu.append(markerGroup(texts.markerColors, colors), markerGroup(texts.markerIcons, [...icons, noIcon]));
  menu.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && menu.contains(event.relatedTarget))) {
      closeMarkerMenu();
    }
  });
  document.body.append(menu);
  const place = anchor.getBoundingClientRect();
  const top = Math.max(0, Math.min(place.bottom, window.innerHeight - menu.offsetHeight));
  menu.style.left = `${String(place.left)}px`;
  menu.style.top = `${String(top)}px`;
  markerMenu = { element: menu, anchor };
  (menu.querySelector<HTMLButtonElement>("[aria-pressed='true']") ?? colors[0]).focus();
}

/**
 * Gives project `projectId` marker `color` and `icon`, `null` for the color
 * marker, then redraws the rail with the project Rust returns.
 */
async function chooseMarker(projectId: number, color: string, icon: string | null): Promise<void> {
  closeMarkerMenu();
  const updated = await setProjectMarker(projectId, color, icon);
  projects = projects.map((project) => (project.id === updated.id ? updated : project));
  renderProjects();
  projectList.querySelector<HTMLButtonElement>(`[data-project="${String(projectId)}"]`)?.focus();
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
 * Removes the selected project, closing all its tabs, then selects the project Rust gives, without opening a tab.
 * The displayed project is stored as Rust's selection first, so the neighbour Rust picks is the neighbour of the removed one.
 */
async function removeSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  await rememberSelection(selected.id);
  await removeProject(selected.id);
  if (selectedId === selected.id) {
    selectedId = undefined;
  }
  await closeProjectTabs(selected.id);
  await refreshProjects();
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && markerMenu !== undefined) {
    const { anchor } = markerMenu;
    closeMarkerMenu();
    anchor.focus();
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

window.addEventListener("resize", closeMarkerMenu);

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
