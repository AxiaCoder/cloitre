import { decideKey } from "./keys";
import type { SpawnMode } from "./pty";
import { isFailedResume } from "./resume";
import { SessionSlot, type TerminalSize } from "./session";
import { messages, texts } from "./strings";
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
  /** The user asked, from the end notice, the start notice or the start failure card, for a new session in this tab. */
  onRestart(): void;
  /** The user asked, from the start notice, to resume this tab's previous conversation. */
  onResume(): void;
  /** The user asked, from the end notice or the start failure card, to close this tab. */
  onClose(): void;
  /** The user asked, from the start failure card, to start again in `mode`, the mode that failed. */
  onRetry(mode: SpawnMode): void;
  /** The session set the terminal title to `title`, as received, control characters included. */
  onTitle(title: string): void;
}

/**
 * Why the start notice offers Resume and New session: `"resume"` for a
 * restored tab, `{ failedWith }` after a resume that ended with exit code
 * `failedWith` within the failure window (see {@link isFailedResume}).
 */
export type StartOffer = "resume" | { readonly failedWith: number };

/** Returns the start notice text for `offer`. */
function offerText(offer: StartOffer): string {
  return offer === "resume" ? texts.resumeOffer : messages.resumeFailed(offer.failedWith);
}

/** Returns a new `<button>` of `className` showing `text`, that calls `onClick`. */
function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const created = document.createElement("button");
  created.type = "button";
  created.className = className;
  created.textContent = text;
  created.addEventListener("click", onClick);
  return created;
}

/** Returns a new element of `tagName` with `className` and `text`. */
function textElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tagName);
  created.className = className;
  created.textContent = text;
  return created;
}

/** Returns the text of a start refusal: the message of an `Error`, else the value as text. */
function refusalText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The terminal and the `claude` session of one session tab. When the session
 * ends, a notice over the terminal gives its exit code and offers Restart and
 * Close; when a resume fails, a start notice gives its exit code and offers
 * Resume and New session. While a session starts, a card over the terminal
 * says so; when Rust refuses the start, a card gives the full refusal and
 * offers Try again and Close.
 */
export class TabPane extends Pane {
  readonly slot = new SessionSlot();
  /** The recording indicator text of this tab's session, or `undefined` when there is none. */
  recording: string | undefined;
  private readonly endNotice: HTMLDivElement;
  private readonly endText: HTMLSpanElement;
  private readonly startNotice: HTMLDivElement;
  private readonly startText: HTMLSpanElement;
  private readonly startingCard: HTMLDivElement;
  private readonly startingFolder: HTMLParagraphElement;
  private readonly failureCard: HTMLDivElement;
  private readonly failureText: HTMLParagraphElement;
  private readonly failureNewSession: HTMLButtonElement;
  private failedMode: SpawnMode = "new";
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
    terminal.onTitleChange((title) => {
      handlers.onTitle(title);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const decision = decideKey(event, terminal.hasSelection());
      if (decision === "terminal") {
        return true;
      }
      if (decision === "copy" && event.type === "keydown") {
        setTimeout(() => {
          terminal.clearSelection();
        }, 0);
      }
      if (decision === "paste" || decision === "copy") {
        return false;
      }
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat) {
        handlers.onMarkKey();
      }
      return false;
    });
    this.endText = document.createElement("span");
    this.endNotice = document.createElement("div");
    this.endNotice.className = "end-notice";
    this.endNotice.setAttribute("role", "status");
    this.endNotice.hidden = true;
    this.endNotice.append(
      this.endText,
      button(texts.restart, "primary", () => {
        handlers.onRestart();
      }),
      button(texts.close, "", () => {
        handlers.onClose();
      }),
    );
    this.startText = document.createElement("span");
    this.startNotice = document.createElement("div");
    this.startNotice.className = "start-notice";
    this.startNotice.setAttribute("role", "status");
    this.startNotice.hidden = true;
    this.startNotice.append(
      this.startText,
      button(texts.resume, "primary", () => {
        handlers.onResume();
      }),
      button(texts.newSession, "", () => {
        handlers.onRestart();
      }),
    );
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    spinner.append(...[1, 2, 3].map(() => document.createElement("span")));
    this.startingFolder = textElement("p", "path", "");
    this.startingCard = document.createElement("div");
    this.startingCard.className = "pane-card starting-card";
    this.startingCard.setAttribute("role", "status");
    this.startingCard.hidden = true;
    this.startingCard.append(textElement("h2", "", texts.startingTitle), spinner, this.startingFolder);
    this.failureText = textElement("p", "error", "");
    this.failureNewSession = button(texts.newSession, "", () => {
      handlers.onRestart();
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(
      button(texts.tryAgain, "primary", () => {
        handlers.onRetry(this.failedMode);
      }),
      this.failureNewSession,
      button(texts.close, "", () => {
        handlers.onClose();
      }),
    );
    this.failureCard = document.createElement("div");
    this.failureCard.className = "pane-card failure-card";
    this.failureCard.setAttribute("role", "alert");
    this.failureCard.hidden = true;
    this.failureCard.append(textElement("h2", "", texts.startFailedTitle), this.failureText, actions);
    this.container.append(this.endNotice, this.startNotice, this.startingCard, this.failureCard);
  }

  /** Shows the start notice with `offer`, over the end notice, which it hides. */
  showOffer(offer: StartOffer): void {
    this.startText.textContent = offerText(offer);
    this.startNotice.hidden = false;
    this.endNotice.hidden = true;
  }

  /**
   * Starts `claude` for this tab in `mode` on a cleared, fitted screen, in
   * project folder `folder`. Hides both notices and any failure card, and
   * shows the starting card, naming `folder`, until the start settles. A start
   * Rust refuses shows the failure card with the full refusal; its Try again
   * asks for `mode` again, and a refused resume also offers New session. A resume that fails (see {@link isFailedResume})
   * shows the start notice with its exit code instead of the end notice.
   * Settles as {@link SessionSlot.start} does.
   */
  async start(mode: SpawnMode, folder: string): Promise<boolean> {
    this.hideOffer();
    this.endNotice.hidden = true;
    this.failureCard.hidden = true;
    this.startingFolder.textContent = messages.startingFolder(folder);
    this.startingCard.hidden = false;
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
      this.failedMode = mode;
      this.failureNewSession.hidden = mode !== "resume";
      this.failureText.textContent = refusalText(error);
      this.failureCard.hidden = false;
      throw error;
    } finally {
      this.startingCard.hidden = true;
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
    this.startNotice.hidden = true;
  }

  /** Shows the end notice of the last session that ended, if any. */
  private showEndNotice(): void {
    if (this.exitCode === undefined) {
      return;
    }
    this.endText.textContent = messages.sessionEnded(this.exitCode);
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
