import { decideKey } from "./keys";
import type { SpawnMode } from "./pty";
import { isFailedResume } from "./resume";
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
  /** The user asked, from the end notice or the start notice, for a new session in this tab. */
  onRestart(): void;
  /** The user asked, from the start notice, to resume this tab's previous conversation. */
  onResume(): void;
  /** The user asked, from the end notice, to close this tab. */
  onClose(): void;
}

/**
 * Why the start notice offers Resume and New session: `"resume"` for a
 * restored tab, `{ failedWith }` after a resume that ended with exit code
 * `failedWith` within the failure window (see {@link isFailedResume}).
 */
export type StartOffer = "resume" | { readonly failedWith: number };

/** Returns the start notice text for `offer`. */
function offerText(offer: StartOffer): string {
  if (offer === "resume") {
    return "Resume the previous conversation, or start a new session.";
  }
  return `Claude Code exited with code ${String(offer.failedWith)} while resuming. The previous conversation may no longer exist.`;
}

/**
 * The terminal and the `claude` session of one session tab. When the session
 * ends, a notice over the terminal gives its exit code and offers Restart and
 * Close; when a resume fails, a start notice gives its exit code and offers
 * Resume and New session.
 */
export class TabPane extends Pane {
  readonly slot = new SessionSlot();
  /** The recording indicator text of this tab's session, or `undefined` when there is none. */
  recording: string | undefined;
  private readonly endNotice: HTMLDivElement;
  private readonly endText: HTMLSpanElement;
  private readonly startNotice: HTMLDivElement;
  private readonly startText: HTMLSpanElement;
  private exitCode: number | undefined;
  private offer: StartOffer | undefined;

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
    this.startText = document.createElement("span");
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "primary";
    resume.textContent = "Resume";
    resume.addEventListener("click", () => {
      handlers.onResume();
    });
    const newSession = document.createElement("button");
    newSession.type = "button";
    newSession.textContent = "New session";
    newSession.addEventListener("click", () => {
      handlers.onRestart();
    });
    this.startNotice = document.createElement("div");
    this.startNotice.className = "start-notice";
    this.startNotice.setAttribute("role", "status");
    this.startNotice.hidden = true;
    this.startNotice.append(this.startText, resume, newSession);
    this.container.append(this.endNotice, this.startNotice);
  }

  /** Shows the start notice with `offer`, over the end notice, which it hides. */
  showOffer(offer: StartOffer): void {
    this.offer = offer;
    this.startText.textContent = offerText(offer);
    this.startNotice.hidden = false;
    this.endNotice.hidden = true;
  }

  /**
   * Starts `claude` for this tab in `mode` on a cleared, fitted screen, hiding
   * both notices. A start Rust refuses shows the notice that was up again: the
   * start notice, else the end notice of the previous session, if any. A
   * resume that fails (see {@link isFailedResume}) shows the start notice
   * with its exit code instead of the end notice. Settles as
   * {@link SessionSlot.start} does.
   */
  async start(mode: SpawnMode): Promise<boolean> {
    const offered = this.offer;
    this.hideOffer();
    this.endNotice.hidden = true;
    const startedAt = Date.now();
    try {
      return await this.slot.start(this.tabId, mode, () => this.prepareScreen(), {
        onOutput: (bytes) => {
          this.view.terminal.write(bytes);
        },
        onExit: (code) => {
          this.exitCode = code;
          if (isFailedResume(mode, code, Date.now() - startedAt)) {
            this.showOffer({ failedWith: code });
          } else {
            this.showEndNotice();
          }
          this.handlers.onExit(code);
        },
      });
    } catch (error) {
      if (offered) {
        this.showOffer(offered);
      } else {
        this.showEndNotice();
      }
      throw error;
    }
  }

  /** Stops the session, then disposes of the terminal and removes the container. Never rejects. */
  async close(): Promise<void> {
    this.hide();
    await this.slot.stop();
    this.dispose();
  }

  /** Hides the start notice. */
  private hideOffer(): void {
    this.offer = undefined;
    this.startNotice.hidden = true;
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
