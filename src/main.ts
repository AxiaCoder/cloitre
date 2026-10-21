import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { open } from "@tauri-apps/plugin-dialog";

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
const statusText = element("status", HTMLSpanElement);
const view = new TerminalView(element("terminal", HTMLDivElement));
const slot = new SessionSlot();

/** Shows a short message in the control bar. */
function showStatus(message: string): void {
  statusText.textContent = message;
}

/** Clears the screen, refits it and returns the size to start a session with. */
function prepareScreen(): { cols: number; rows: number } {
  view.terminal.reset();
  view.fit();
  return { cols: view.terminal.cols, rows: view.terminal.rows };
}

/** Stops the current session and starts `claude` in `folder` on a cleared screen. */
async function startSession(folder: string): Promise<void> {
  try {
    const running = await slot.start(folder, prepareScreen, {
      onOutput: (bytes) => {
        view.terminal.write(bytes);
      },
      onExit: (code) => {
        view.terminal.write(`\r\n[claude exited with code ${String(code)}]\r\n`);
      },
    });
    if (running) {
      showStatus(folder);
      view.terminal.focus();
    }
  } catch (error) {
    showStatus(String(error));
  }
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
