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
import { decideKey } from "./keys";
import { chooseWorkArea, findProject, keepSelection, projectToStart } from "./project-selection";
import { addProject, listProjects, relocateProject, removeProject, type Project } from "./projects";
import { ReplayDeck, type LoadedReplay } from "./replay-deck";
import { SessionSlot } from "./session";
import { TerminalView, isRenderer, isUnicodeVersion, showRenderer, startRenderer } from "./terminal-view";

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
const view = new TerminalView(element("terminal", HTMLDivElement));
const slot = new SessionSlot();

/** The xterm.js terminal, as a replay draws into it. */
const replayTarget: ReplayTarget = {
  reset: () => {
    view.terminal.reset();
  },
  resize: (cols, rows) => {
    view.terminal.resize(cols, rows);
  },
  write: (data) => {
    view.terminal.write(data);
  },
  drained: () =>
    new Promise((resolve) => {
      view.terminal.write("", resolve);
    }),
};

/** The replay on screen; loads, session starts and stops take their turn through it. */
const deck = new ReplayDeck(replayTarget, {
  stopSession: async () => {
    await slot.stop();
    showRecording(undefined);
  },
  read: readRecording,
  hold: () => {
    view.autoFit = false;
  },
  release: () => {
    view.clearAndFit();
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

/** Clears the screen, refits it and returns the size to start a session with. */
function prepareScreen(): { cols: number; rows: number } {
  view.terminal.reset();
  view.fit();
  return { cols: view.terminal.cols, rows: view.terminal.rows };
}

/** The projects as last listed by Rust. */
let projects: readonly Project[] = [];
/** The id of the selected project, if any. */
let selectedId: number | undefined;
/** Whether the user closed the load warning; it stays closed until the app restarts. */
let warningClosed = false;

/**
 * Stops the current session and the replay, then starts `claude` in `folder`
 * on a cleared screen. Resolves with whether the session started; a failure is
 * shown in the control bar.
 */
async function startSession(folder: string): Promise<boolean> {
  try {
    const running = await deck.claim(() =>
      slot.start(folder, prepareScreen, {
        onOutput: (bytes) => {
          view.terminal.write(bytes);
        },
        onExit: (code) => {
          view.terminal.write(`\r\n[claude exited with code ${String(code)}]\r\n`);
          showRecording(undefined);
          refreshRecordingsOrReport();
        },
      }),
    );
    const session = slot.current;
    if (running && session) {
      showStatus(folder);
      view.terminal.focus();
      const name = await currentRecording(session);
      if (slot.current === session) {
        showRecording(name === null ? "not recorded" : `● recording ${name}`);
      }
      refreshRecordingsOrReport();
    }
    return running;
  } catch (error) {
    showStatus(String(error));
    return false;
  }
}

/** Stops the current session and the replay. */
async function stopSession(): Promise<void> {
  await deck.claim(async () => {
    await slot.stop();
    showRecording(undefined);
  });
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
 * Reloads the project list, then selects project `id` and starts a session in
 * its folder, unless that project's session already runs. Selecting a project
 * whose folder is gone stops the running session and shows the missing-folder
 * state; so does a session start that Rust refuses because the folder has just gone.
 */
async function selectProject(id: number): Promise<void> {
  await refreshProjects();
  const toStart = projectToStart(projects, id, selectedId, slot.current !== undefined);
  selectedId = keepSelection(projects, id);
  renderProjects();
  if (toStart) {
    if (!(await startSession(toStart.path))) {
      await refreshProjects();
    }
  } else if (findProject(projects, id)?.exists === false) {
    await stopSession();
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

/** Removes the selected project, stopping its session. */
async function removeSelected(): Promise<void> {
  const selected = findProject(projects, selectedId);
  if (!selected) {
    return;
  }
  await removeProject(selected.id);
  if (selectedId === selected.id) {
    selectedId = undefined;
    await stopSession();
  }
  await refreshProjects();
}

/** Writes a marker in the recording of the running session. */
async function mark(): Promise<void> {
  const session = slot.current;
  if (!session) {
    showStatus("No session to mark");
    return;
  }
  await markRecording(session);
  showStatus(`Marked at ${new Date().toLocaleTimeString()}`);
}

/**
 * Stops the session and any replay, then loads the chosen recording on a
 * replay of its own. The grid stops following its container until the replay ends.
 */
async function loadReplay(): Promise<LoadedReplay | undefined> {
  const name = recordingsSelect.value;
  if (name === "") {
    showStatus("No recording chosen");
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

view.terminal.onData((data) => {
  slot.write(data).catch((error: unknown) => {
    showStatus(String(error));
  });
});

view.terminal.onResize((size) => {
  slot.resize(size).catch((error: unknown) => {
    showStatus(String(error));
  });
});

view.terminal.attachCustomKeyEventHandler((event) => {
  const decision = decideKey(event);
  if (decision === "terminal") {
    return true;
  }
  if (decision === "paste") {
    return false;
  }
  event.preventDefault();
  if (event.type === "keydown" && !event.repeat) {
    report(mark);
  }
  return false;
});

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

warningClose.addEventListener("click", () => {
  warningClosed = true;
  warningBar.hidden = true;
});

markButton.addEventListener("click", () => {
  report(mark);
  view.terminal.focus();
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
    showRenderer(view, wanted, rendererSelect, showStatus);
    view.terminal.focus();
  }
});

unicodeSelect.addEventListener("change", () => {
  const wanted = unicodeSelect.value;
  if (isUnicodeVersion(wanted)) {
    view.setUnicodeVersion(wanted);
    view.terminal.focus();
  }
});

startRenderer(view, rendererSelect, showStatus);
refreshRecordingsOrReport();
report(refreshProjects);
