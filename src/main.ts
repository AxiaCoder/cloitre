import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { open } from "@tauri-apps/plugin-dialog";

import { killPty, resizePty, spawnPty, writePty, type PtySession } from "./pty";
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
const statusText = element("status", HTMLSpanElement);
const view = new TerminalView(element("terminal", HTMLDivElement));

let session: PtySession | undefined;
let generation = 0;

/** Shows a short message in the control bar. */
function showStatus(message: string): void {
  statusText.textContent = message;
}

/** Stops the current session, if any. Output still in flight from it is ignored. */
async function stopSession(): Promise<void> {
  generation += 1;
  const current = session;
  session = undefined;
  if (current) {
    await killPty(current).catch(() => undefined);
  }
}

/** Stops the current session and starts `claude` in `folder` on a cleared screen. */
async function startSession(folder: string): Promise<void> {
  await stopSession();
  const mine = generation;
  view.terminal.reset();
  view.fit();
  try {
    session = await spawnPty(folder, view.terminal.cols, view.terminal.rows, {
      onOutput: (bytes) => {
        if (mine === generation) {
          view.terminal.write(bytes);
        }
      },
      onExit: (code) => {
        if (mine === generation) {
          view.terminal.write(`\r\n[claude exited with code ${String(code)}]\r\n`);
          void stopSession();
        }
      },
    });
    showStatus(folder);
    view.terminal.focus();
  } catch (error) {
    showStatus(String(error));
  }
}

view.terminal.onData((data) => {
  if (session) {
    writePty(session, data).catch((error: unknown) => {
      showStatus(String(error));
    });
  }
});

view.terminal.onResize(({ cols, rows }) => {
  if (session) {
    resizePty(session, cols, rows).catch((error: unknown) => {
      showStatus(String(error));
    });
  }
});

pickButton.addEventListener("click", () => {
  void open({ directory: true, multiple: false }).then((folder) => {
    if (folder !== null) {
      return startSession(folder);
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

window.addEventListener("beforeunload", () => {
  void stopSession();
});
