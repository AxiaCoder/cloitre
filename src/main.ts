import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import {
  currentRecording,
  listRecordings,
  markRecording,
  readRecording,
  type ReplaySpeed,
  type ReplayTarget,
} from "./recording";
import { chooseWorkArea, clickAction, findProject, keepSelection } from "./project-selection";
import { addProject, listProjects, relocateProject, removeProject, type Project } from "./projects";
import { ReplayDeck, type LoadedReplay } from "./replay-deck";
import { TabPane } from "./tab-pane";
import { TabModel, type Tab } from "./tabs";
import { isRenderer, isUnicodeVersion, showRenderer, type TerminalView } from "./terminal-view";

/** Returns the element with `id`, or throws when the page lacks it. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`missing element #${id}`);
  }
  return found;
}

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
const tabBar = element("tab-bar", HTMLDivElement);
const tabList = element("tab-list", HTMLDivElement);
const newTabButton = element("new-tab", HTMLButtonElement);
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
/** The terminal and session of each open tab, by tab id. */
const panes = new Map<number, TabPane>();
/** The projects as last listed by Rust. */
let projects: readonly Project[] = [];
/** The id of the selected project, if any. */
let selectedId: number | undefined;
/** How many project selections have started; the latest one is the only one that acts. */
let selectionCount = 0;
/** Whether the user closed the load warning; it stays closed until the app restarts. */
let warningClosed = false;
/** The tab a replay draws into, from the moment it takes the screen until it ends. */
let replayPane: TabPane | undefined;

/** Returns the active tab of the selected project, if any. */
function activeTab(): Tab | undefined {
  return selectedId === undefined ? undefined : tabs.activeOf(selectedId);
}

/** Returns the pane of the selected project's active tab, if any. */
function activePane(): TabPane | undefined {
  const tab = activeTab();
  return tab ? panes.get(tab.id) : undefined;
}

/** The terminal a replay draws into: the one it took, else the active tab's. */
function replayView(): TerminalView | undefined {
  return (replayPane ?? activePane())?.view;
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
  stopSession: async () => {
    const pane = activePane();
    if (pane) {
      await pane.slot.stop();
      pane.recording = undefined;
      tabs.setState(pane.tabId, "exited");
      renderTabs();
    }
  },
  read: readRecording,
  hold: () => {
    replayPane = activePane();
    if (replayPane) {
      replayPane.view.autoFit = false;
    }
  },
  release: () => {
    replayPane?.view.clearAndFit();
    replayPane = undefined;
  },
});

/** Shows a short message in the control bar. */
function showStatus(message: string): void {
  statusText.textContent = message;
}

/** Shows the recording indicator with `text`, or hides it when `text` is `undefined`. */
function showRecording(text: string | undefined): void {
  recordingText.hidden = text === undefined;
  recordingText.textContent = text ?? "";
}

/** Reloads the list of recordings, keeping the current choice when it is still there. */
async function refreshRecordings(): Promise<void> {
  const chosen = recordingsSelect.value;
  const recordings = await listRecordings();
  recordingsSelect.replaceChildren(
    ...recordings.map((recording) => {
      const kilobytes = Math.ceil(recording.size / 1024);
      return new Option(`${recording.name} (${String(kilobytes)} KB)`, recording.name);
    }),
  );
  if (recordings.some((recording) => recording.name === chosen)) {
    recordingsSelect.value = chosen;
  }
}

/** Reloads the list of recordings, showing a failure in the control bar. */
function refreshRecordingsOrReport(): void {
  refreshRecordings().catch((error: unknown) => {
    showStatus(String(error));
  });
}

/** Builds the tab bar entry of `tab`: its label, which activates it, and its close button. */
function tabElement(tab: Tab, active: boolean): HTMLDivElement {
  const item = document.createElement("div");
  item.className = `tab ${tab.state}`;
  item.classList.toggle("active", active);
  item.setAttribute("role", "tab");
  item.setAttribute("aria-selected", String(active));
  const label = document.createElement("button");
  label.type = "button";
  label.className = "tab-label";
  label.textContent = tab.label;
  label.title = `${tab.label} (${tab.state})`;
  label.addEventListener("click", () => {
    activateTab(tab.id);
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.textContent = "×";
  close.setAttribute("aria-label", `Close ${tab.label}`);
  close.addEventListener("click", () => {
    report(() => closeTab(tab.id));
  });
  item.append(label, close);
  return item;
}

/**
 * Draws the selected project's tab bar and shows its active tab's terminal;
 * every other terminal is hidden, its session left running.
 */
function renderTabs(): void {
  const area = chooseWorkArea(projects, selectedId);
  const project = area.kind === "terminal" ? findProject(projects, selectedId) : undefined;
  const active = project ? tabs.activeOf(project.id) : undefined;
  tabBar.hidden = project === undefined;
  tabList.replaceChildren(...(project ? tabs.tabsOf(project.id) : []).map((tab) => tabElement(tab, tab === active)));
  tabList.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  for (const [id, pane] of panes) {
    if (id === active?.id) {
      pane.show();
    } else {
      pane.hide();
    }
  }
  showRecording(active ? panes.get(active.id)?.recording : undefined);
}

/** Makes tab `tabId` its project's active tab, shows it and gives it the keyboard. */
function activateTab(tabId: number): void {
  tabs.activate(tabId);
  renderTabs();
  panes.get(tabId)?.view.terminal.focus();
}

/** Creates the pane of tab `tabId`, with the renderer and width table the controls show. */
function createPane(tabId: number): TabPane {
  const pane = new TabPane(terminals, tabId, {
    onExit: () => {
      tabs.setState(tabId, "exited");
      const exited = panes.get(tabId);
      if (exited) {
        exited.recording = undefined;
      }
      renderTabs();
      refreshRecordingsOrReport();
    },
    onError: (error) => {
      showStatus(String(error));
    },
    onMarkKey: () => {
      report(mark);
    },
  });
  const renderer = rendererSelect.value;
  showRenderer(pane.view, isRenderer(renderer) ? renderer : "webgl", rendererSelect, showStatus);
  const unicode = unicodeSelect.value;
  if (isUnicodeVersion(unicode)) {
    pane.view.setUnicodeVersion(unicode);
  }
  panes.set(tabId, pane);
  return pane;
}

/**
 * Ends the replay, then starts `claude` in `folder` for tab `tabId`. Resolves
 * with whether the session started; a failure is shown in the control bar.
 */
async function startTab(tabId: number, folder: string): Promise<boolean> {
  const pane = panes.get(tabId);
  if (!pane) {
    return false;
  }
  try {
    const running = await deck.claim(() => pane.start(folder));
    const session = pane.slot.current;
    if (running && session) {
      if (tabs.find(tabId)?.state === "starting") {
        tabs.setState(tabId, "running");
      }
      renderTabs();
      if (pane === activePane()) {
        showStatus(folder);
        pane.view.terminal.focus();
      }
      const name = await currentRecording(session);
      if (pane.slot.current === session) {
        pane.recording = name === null ? "not recorded" : `● recording ${name}`;
        if (pane === activePane()) {
          showRecording(pane.recording);
        }
      }
      refreshRecordingsOrReport();
    }
    return running;
  } catch (error) {
    showStatus(String(error));
    return false;
  }
}

/**
 * Opens a tab in `project` and starts its session. A start Rust refuses closes
 * the tab and reloads the projects; when the folder is gone, every tab of the
 * project is closed and the missing-folder state shows.
 */
async function openTab(project: Project): Promise<void> {
  const tab = tabs.open(project.id);
  createPane(tab.id);
  renderTabs();
  if (await startTab(tab.id, project.path)) {
    return;
  }
  if (tabs.find(tab.id)) {
    await closeTab(tab.id);
  }
  await refreshProjects();
  if (findProject(projects, project.id)?.exists === false) {
    await closeProjectTabs(project.id);
  }
}

/** Closes tab `tabId`: stops its session and disposes of its terminal. */
async function closeTab(tabId: number): Promise<void> {
  const pane = panes.get(tabId);
  if (!pane) {
    return;
  }
  panes.delete(tabId);
  tabs.close(tabId);
  pane.hide();
  renderTabs();
  if (pane === replayPane) {
    await deck.stop();
  }
  await pane.close();
  activePane()?.view.terminal.focus();
}

/** Closes every tab of project `projectId`. */
async function closeProjectTabs(projectId: number): Promise<void> {
  await Promise.all(tabs.tabsOf(projectId).map((tab) => closeTab(tab.id)));
}

/** Draws the project rail and the work area from `projects` and `selectedId`. */
function renderProjects(): void {
  projectList.replaceChildren(
    ...projects.map((project) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project";
      button.classList.toggle("active", project.id === selectedId);
      button.classList.toggle("missing", !project.exists);
      button.title = project.exists ? project.path : `Folder not found: ${project.path}`;
      const name = document.createElement("span");
      name.className = "project-name";
      name.textContent = project.name;
      const path = document.createElement("span");
      path.className = "project-path";
      path.textContent = project.path;
      button.append(name, path);
      button.addEventListener("click", () => {
        report(() => selectProject(project.id));
      });
      const item = document.createElement("li");
      item.append(button);
      return item;
    }),
  );
  const area = chooseWorkArea(projects, selectedId);
  emptyState.hidden = area.kind !== "empty";
  missingState.hidden = area.kind !== "missing";
  missingPath.textContent = area.kind === "missing" ? area.project.path : "";
  renderTabs();
}

/** Reloads the project list from Rust, keeps the selection when it is still there, and redraws. */
async function refreshProjects(): Promise<void> {
  const list = await listProjects();
  projects = list.projects;
  selectedId = keepSelection(projects, selectedId);
  warningText.textContent = list.warning ?? "";
  warningBar.hidden = list.warning === null || warningClosed;
  renderProjects();
}

/**
 * Reloads the project list, then selects project `id`: shows its active tab,
 * or opens one when it has none. Selecting a project whose folder is gone closes
 * its tabs and shows the missing-folder state. Other projects' sessions keep
 * running. A selection overtaken by a later one while the list reloads does nothing.
 */
async function selectProject(id: number): Promise<void> {
  selectionCount += 1;
  const selection = selectionCount;
  await refreshProjects();
  if (selection !== selectionCount) {
    return;
  }
  const action = clickAction(projects, id, tabs.tabsOf(id).length > 0);
  selectedId = keepSelection(projects, id);
  renderProjects();
  if (action.kind === "open") {
    await openTab(action.project);
  } else if (action.kind === "missing") {
    await closeProjectTabs(id);
  } else if (action.kind === "show") {
    showStatus(findProject(projects, id)?.path ?? "");
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

/** Opens the folder picker to give the selected project a new folder, then selects it again. */
async function relocateSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  const moved = await relocateProject(selected.id);
  if (moved === null) {
    return;
  }
  await selectProject(moved.id);
}

/** Removes the selected project, closing all its tabs. */
async function removeSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  await removeProject(selected.id);
  if (selectedId === selected.id) {
    selectedId = undefined;
  }
  await closeProjectTabs(selected.id);
  await refreshProjects();
}

/** Writes a marker in the recording of the active tab's session. */
async function mark(): Promise<void> {
  const session = activePane()?.slot.current;
  if (!session) {
    showStatus("No session to mark");
    return;
  }
  await markRecording(session);
  showStatus(`Marked at ${new Date().toLocaleTimeString()}`);
}

/**
 * Stops the active tab's session and any replay, then loads the chosen recording
 * on a replay of its own, drawn in the active tab. The grid stops following its
 * container until the replay ends.
 */
async function loadReplay(): Promise<LoadedReplay | undefined> {
  const name = recordingsSelect.value;
  if (name === "") {
    showStatus("No recording chosen");
    return undefined;
  }
  if (!activePane()) {
    showStatus("Open a tab to replay into");
    return undefined;
  }
  const { replay, truncated } = await deck.load(name);
  if (truncated) {
    showStatus(`${name}: the last record is incomplete and was dropped`);
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
  showStatus(`Replaying ${loaded.name}`);
  const stop = await deck.run(loaded, speed, false);
  if (stop === "end") {
    showStatus(`${loaded.name}: end of recording`);
  }
}

/** Replays instantly up to the next marker of the chosen recording, then pauses there. */
async function replayToNextMark(): Promise<void> {
  const onScreen = deck.current;
  const current =
    onScreen?.name === recordingsSelect.value && !onScreen.player.finished ? onScreen : await loadReplay();
  if (!current) {
    return;
  }
  const stop = await deck.run(current, "instant", true);
  if (stop === "marker") {
    current.marks += 1;
    showStatus(`${current.name}: paused at marker ${String(current.marks)}`);
  } else if (stop === "end") {
    showStatus(`${current.name}: no marker left, end of recording`);
  }
}

/** Runs `action`, showing its failure in the control bar. */
function report(action: () => Promise<void>): void {
  action().catch((error: unknown) => {
    showStatus(String(error));
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

warningClose.addEventListener("click", () => {
  warningClosed = true;
  warningBar.hidden = true;
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
      showStatus("Replay stopped");
    }
  });
});

rendererSelect.addEventListener("change", () => {
  const wanted = rendererSelect.value;
  if (isRenderer(wanted)) {
    for (const pane of panes.values()) {
      showRenderer(pane.view, wanted, rendererSelect, showStatus);
    }
    activePane()?.view.terminal.focus();
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

refreshRecordingsOrReport();
report(refreshProjects);
