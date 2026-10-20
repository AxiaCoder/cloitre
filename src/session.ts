import { killPty, resizePty, spawnPty, writePty, type PtyHandlers, type PtySession } from "./pty";

/** Terminal size, in character cells. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Holds at most one `claude` session. Starting a new one stops the previous
 * one, and output or exit notices still in flight from a stopped session are
 * dropped instead of reaching the handlers.
 */
export class SessionSlot {
  private session: PtySession | undefined;
  private generation = 0;

  /** The running session, or `undefined` when none is running. */
  get current(): PtySession | undefined {
    return this.session;
  }

  /** Stops the current session, if any. Never rejects: a failed kill is ignored. */
  async stop(): Promise<void> {
    this.generation += 1;
    const current = this.session;
    this.session = undefined;
    if (current) {
      await killPty(current).catch(() => undefined);
    }
  }

  /**
   * Stops the current session, calls `prepare` and starts `claude` in `folder`
   * with the size `prepare` returns. `handlers` only hear from this session; its
   * exit also stops it, after `onExit` ran. Rejects with the Rust refusal message,
   * leaving no session running.
   */
  async start(folder: string, prepare: () => TerminalSize, handlers: PtyHandlers): Promise<void> {
    await this.stop();
    const mine = this.generation;
    const { cols, rows } = prepare();
    this.session = await spawnPty(folder, cols, rows, {
      onOutput: (bytes) => {
        if (mine === this.generation) {
          handlers.onOutput(bytes);
        }
      },
      onExit: (code) => {
        if (mine === this.generation) {
          handlers.onExit(code);
          void this.stop();
        }
      },
    });
  }

  /** Sends keyboard input to the current session. Resolves at once when none is running. */
  async write(data: string): Promise<void> {
    if (this.session) {
      await writePty(this.session, data);
    }
  }

  /** Resizes the current session's terminal. Resolves at once when none is running. */
  async resize(size: TerminalSize): Promise<void> {
    if (this.session) {
      await resizePty(this.session, size.cols, size.rows);
    }
  }
}
