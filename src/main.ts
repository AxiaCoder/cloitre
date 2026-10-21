import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { open } from "@tauri-apps/plugin-dialog";

import {
  currentRecording,
  listRecordings,
  markRecording,
  readRecording,
  type ReplaySpeed,
  type ReplayTarget,
} from "./recording";
import { ReplayDeck, type LoadedReplay } from "./replay-deck";
import { SessionSlot } from "./session";
import { TerminalView, isRenderer, isUnicodeVersion } from "./terminal-view";

/** Returns the element with `id`, or throws when the page lacks it. */
function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) {
    throw new Error(`missing element #${id}`);
  }
  return found;
}

const pickButton = element("pick-folder", HTMLButtonElement);
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

/** Stops the current session and the replay, then starts `claude` in `folder` on a cleared screen. */
async function startSession(folder: string): Promise<void> {
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
  } catch (error) {
    showStatus(String(error));
  }
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
  const isMarkShortcut =
    event.code === "F9" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (!isMarkShortcut) {
    return true;
  }
  event.preventDefault();
  if (event.type === "keydown" && !event.repeat) {
    report(mark);
  }
  return false;
});

pickButton.addEventListener("click", () => {
  void open({ directory: true, multiple: false }).then((folder) => {
    if (folder !== null) {
      return startSession(folder);
    }
  });
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
    rendererSelect.value = view.setRenderer(wanted, () => {
      rendererSelect.value = "dom";
      showStatus("WebGL context lost, back to the DOM renderer");
    });
    if (rendererSelect.value !== wanted) {
      showStatus("WebGL is not available, DOM renderer kept");
    }
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

refreshRecordingsOrReport();
