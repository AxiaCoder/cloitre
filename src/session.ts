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
  private size: TerminalSize | undefined;
  private lastWrite: Promise<unknown> = Promise.resolve();

  /** The running session, or `undefined` when none is running. */
  get current(): PtySession | undefined {
    return this.session;
  }

  /**
   * Stops the current session, if any, and any session still starting.
   * Never rejects: a failed kill is ignored.
   */
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
   * exit releases it, after `onExit` ran, and output that arrives after the exit
   * notice still reaches `onOutput` until the next start or stop.
   *
   * Resolves `true` once the session runs, or `false` when another start or a
   * stop came first: that session is then killed. Rejects with the Rust refusal
   * message, leaving no session running.
   */
  async start(folder: string, prepare: () => TerminalSize, handlers: PtyHandlers): Promise<boolean> {
    const stopped = this.stop();
    const mine = this.generation;
    await stopped;
    if (mine !== this.generation) {
      return false;
    }
    const spawnedSize = prepare();
    this.size = spawnedSize;
    let exited = false;
    const spawning = spawnPty(folder, spawnedSize.cols, spawnedSize.rows, {
      onOutput: (bytes) => {
        if (mine === this.generation) {
          handlers.onOutput(bytes);
        }
      },
      onExit: (code) => {
        if (mine === this.generation && !exited) {
          exited = true;
          handlers.onExit(code);
          void spawning.then(
            (session) => {
              this.release(session);
            },
            () => undefined,
          );
        }
      },
    });
    const session = await spawning;
    if (mine !== this.generation) {
      await killPty(session).catch(() => undefined);
      return false;
    }
    this.session = session;
    const wanted = this.size;
    if (wanted.cols !== spawnedSize.cols || wanted.rows !== spawnedSize.rows) {
      await resizePty(session, wanted.cols, wanted.rows).catch(() => undefined);
    }
    return true;
  }

  /** Forgets `session` if it is the current one and releases it on the Rust side. */
  private release(session: PtySession): void {
    if (this.session === session) {
      this.session = undefined;
    }
    void killPty(session).catch(() => undefined);
  }

  /**
   * Sends keyboard input to the current session, after every earlier write.
   * Resolves at once when none is running.
   */
  write(data: string): Promise<void> {
    const session = this.session;
    if (!session) {
      return Promise.resolve();
    }
    const written = this.lastWrite.then(() => writePty(session, data));
    this.lastWrite = written.catch(() => undefined);
    return written;
  }

  /**
   * Resizes the current session's terminal. Without a running session, only
   * remembers the size for a session still starting.
   */
  async resize(size: TerminalSize): Promise<void> {
    this.size = size;
    if (this.session) {
      await resizePty(this.session, size.cols, size.rows);
    }
  }
}
