import { decideKey } from "./keys";
import { SessionSlot, type TerminalSize } from "./session";
import { TerminalView } from "./terminal-view";

/**
 * A terminal in a container of its own, for one tab. A hidden pane keeps
 * receiving output; its grid is refitted when shown again.
 */
abstract class Pane {
  readonly container: HTMLDivElement;
  readonly view: TerminalView;

  /** Opens a terminal for tab `tabId` in a new container appended to `parent`. */
  constructor(
    parent: HTMLElement,
    readonly tabId: number,
  ) {
    this.container = document.createElement("div");
    this.container.className = "terminal-pane";
    parent.append(this.container);
    this.view = new TerminalView(this.container);
  }

  /**
   * Shows the pane and, unless a replay holds the grid, fits it to its container;
   * a size that changed while hidden then reaches the session. The renderer
   * stays the DOM one until the caller picks another.
   */
  show(): void {
    this.container.hidden = false;
    this.view.setVisible(true);
  }

  /** Hides the pane and moves it to the DOM renderer; its terminal keeps writing what it receives. */
  hide(): void {
    this.container.hidden = true;
    this.view.setVisible(false);
  }

  /** Disposes of the terminal and removes the container. */
  protected dispose(): void {
    this.view.dispose();
    this.container.remove();
  }
}

/** What a {@link TabPane} tells the page around it. */
export interface TabPaneHandlers {
  /** The session ended with `code`; the end notice is already on screen. */
  onExit(code: number): void;
  /** Sending input or a size to the session failed. */
  onError(error: unknown): void;
  /** The user pressed the marker key in this terminal. */
  onMarkKey(): void;
  /** The user asked, from the end notice, for a new session in this tab. */
  onRestart(): void;
  /** The user asked, from the end notice, to close this tab. */
  onClose(): void;
}

/**
 * The terminal and the `claude` session of one session tab. When the session
 * ends, a notice over the terminal gives its exit code and offers Restart and Close.
 */
export class TabPane extends Pane {
  readonly slot = new SessionSlot();
  /** The recording indicator text of this tab's session, or `undefined` when there is none. */
  recording: string | undefined;
  private readonly endNotice: HTMLDivElement;
  private readonly endText: HTMLSpanElement;
  private exitCode: number | undefined;

  /** Opens a terminal for session tab `tabId` in a new container appended to `parent`. */
  constructor(
    parent: HTMLElement,
    tabId: number,
    private readonly handlers: TabPaneHandlers,
  ) {
    super(parent, tabId);
    const terminal = this.view.terminal;
    terminal.onData((data) => {
      this.slot.write(data).catch((error: unknown) => {
        handlers.onError(error);
      });
    });
    terminal.onResize((size) => {
      this.slot.resize(size).catch((error: unknown) => {
        handlers.onError(error);
      });
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const decision = decideKey(event);
      if (decision === "terminal") {
        return true;
      }
      if (decision === "paste") {
        return false;
      }
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat) {
        handlers.onMarkKey();
      }
      return false;
    });
    this.endText = document.createElement("span");
    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "primary";
    restart.textContent = "Restart";
    restart.addEventListener("click", () => {
      handlers.onRestart();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", () => {
      handlers.onClose();
    });
    this.endNotice = document.createElement("div");
    this.endNotice.className = "end-notice";
    this.endNotice.setAttribute("role", "status");
    this.endNotice.hidden = true;
    this.endNotice.append(this.endText, restart, close);
    this.container.append(this.endNotice);
  }

  /**
   * Starts `claude` in `folder` for this tab on a cleared, fitted screen, hiding
   * the end notice. A start Rust refuses shows the notice of the previous
   * session again, if there was one. Settles as {@link SessionSlot.start} does.
   */
  async start(folder: string): Promise<boolean> {
    this.endNotice.hidden = true;
    try {
      return await this.slot.start(folder, this.tabId, () => this.prepareScreen(), {
        onOutput: (bytes) => {
          this.view.terminal.write(bytes);
        },
        onExit: (code) => {
          this.exitCode = code;
          this.showEndNotice();
          this.handlers.onExit(code);
        },
      });
    } catch (error) {
      this.showEndNotice();
      throw error;
    }
  }

  /** Stops the session, then disposes of the terminal and removes the container. Never rejects. */
  async close(): Promise<void> {
    this.hide();
    await this.slot.stop();
    this.dispose();
  }

  /** Shows the end notice of the last session that ended, if any. */
  private showEndNotice(): void {
    if (this.exitCode === undefined) {
      return;
    }
    this.endText.textContent = `Claude Code ended (code ${String(this.exitCode)})`;
    this.endNotice.hidden = false;
  }

  /** Clears the screen, refits it and returns the size to start a session with. */
  private prepareScreen(): TerminalSize {
    this.view.terminal.reset();
    this.view.fit();
    return { cols: this.view.terminal.cols, rows: this.view.terminal.rows };
  }
}

/** The terminal of one replay tab: it draws a recording and takes no input. */
export class ReplayPane extends Pane {
  /** Opens a read-only terminal for replay tab `tabId` in a new container appended to `parent`. */
  constructor(parent: HTMLElement, tabId: number) {
    super(parent, tabId);
    this.view.terminal.options.disableStdin = true;
  }

  /** Disposes of the terminal and removes the container. The caller stops the replay first. */
  close(): void {
    this.hide();
    this.dispose();
  }
}
