import { decideKey } from "./keys";
import { SessionSlot, type TerminalSize } from "./session";
import { TerminalView } from "./terminal-view";

/** What a {@link TabPane} tells the page around it. */
export interface TabPaneHandlers {
  /** The session ended with `code`; the exit notice is already on screen. */
  onExit(code: number): void;
  /** Sending input or a size to the session failed. */
  onError(error: unknown): void;
  /** The user pressed the marker key in this terminal. */
  onMarkKey(): void;
}

/**
 * The terminal and the `claude` session of one tab, in a container of its own.
 * A hidden pane keeps receiving output; its grid is refitted when shown again.
 */
export class TabPane {
  readonly container: HTMLDivElement;
  readonly view: TerminalView;
  readonly slot = new SessionSlot();
  /** The recording indicator text of this tab's session, or `undefined` when there is none. */
  recording: string | undefined;

  /** Opens a terminal for tab `tabId` in a new container appended to `parent`. */
  constructor(
    parent: HTMLElement,
    readonly tabId: number,
    private readonly handlers: TabPaneHandlers,
  ) {
    this.container = document.createElement("div");
    this.container.className = "terminal-pane";
    parent.append(this.container);
    this.view = new TerminalView(this.container);
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
  }

  /**
   * Shows the pane and, unless a replay holds the grid, fits it to its container;
   * a size that changed while hidden then reaches the session.
   */
  show(): void {
    this.container.hidden = false;
    if (this.view.autoFit) {
      this.view.fit();
    }
  }

  /** Hides the pane; its terminal keeps writing what the session sends. */
  hide(): void {
    this.container.hidden = true;
  }

  /**
   * Starts `claude` in `folder` for this tab on a cleared, fitted screen.
   * Settles as {@link SessionSlot.start} does.
   */
  start(folder: string): Promise<boolean> {
    return this.slot.start(folder, this.tabId, () => this.prepareScreen(), {
      onOutput: (bytes) => {
        this.view.terminal.write(bytes);
      },
      onExit: (code) => {
        this.view.terminal.write(`\r\n[claude exited with code ${String(code)}]\r\n`);
        this.handlers.onExit(code);
      },
    });
  }

  /** Stops the session, then disposes of the terminal and removes the container. Never rejects. */
  async close(): Promise<void> {
    this.hide();
    await this.slot.stop();
    this.view.terminal.dispose();
    this.container.remove();
  }

  /** Clears the screen, refits it and returns the size to start a session with. */
  private prepareScreen(): TerminalSize {
    this.view.terminal.reset();
    this.view.fit();
    return { cols: this.view.terminal.cols, rows: this.view.terminal.rows };
  }
}
