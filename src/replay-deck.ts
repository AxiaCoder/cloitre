import { Replay, decodeRecording, type ReplaySpeed, type ReplayStop, type ReplayTarget } from "./recording";

/** A replay on screen, with the name of its recording and the markers reached so far. */
export interface LoadedReplay {
  readonly player: Replay;
  readonly name: string;
  marks: number;
}

/** What a {@link ReplayDeck} needs from the page around it. */
export interface ReplayDeckHooks {
  /** Returns the raw bytes of recording `name`. */
  read(name: string): Promise<Uint8Array>;
  /** Called when a replay takes the screen. */
  hold(): void;
  /** Called when the replay on screen ends. */
  release(): void;
}

/**
 * Holds at most one replay on screen. Loads, claims and stops run one at a
 * time, in the order they were asked for, and each one ends the replay on
 * screen first. A replay no longer on screen does not run again.
 */
export class ReplayDeck {
  private loaded: LoadedReplay | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** Draws replays into `target`, around the page reached through `hooks`. */
  constructor(
    private readonly target: ReplayTarget,
    private readonly hooks: ReplayDeckHooks,
  ) {}

  /** The replay on screen, or `undefined` when there is none. */
  get current(): LoadedReplay | undefined {
    return this.loaded;
  }

  /**
   * Once every earlier load, claim and stop has settled, ends the replay on
   * screen, then runs `operation`. Settles as `operation` does.
   */
  claim<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.end();
      return operation();
    });
  }

  /**
   * Stops the replay on screen, then loads recording
   * `name` on a replay of its own. `truncated` tells whether its last record
   * was dropped. Rejects when the read or the decoding fails.
   */
  load(name: string): Promise<{ replay: LoadedReplay; truncated: boolean }> {
    return this.claim(async () => {
      const decoded = decodeRecording(await this.hooks.read(name));
      this.hooks.hold();
      const replay: LoadedReplay = { player: new Replay(decoded.events, this.target), name, marks: 0 };
      this.loaded = replay;
      return { replay, truncated: decoded.truncated };
    });
  }

  /** Ends the replay on screen, after the operations in flight. Resolves `true` when there was one. */
  stop(): Promise<boolean> {
    return this.enqueue(async () => {
      const had = this.loaded !== undefined;
      await this.end();
      return had;
    });
  }

  /**
   * Runs `replay` at `speed`, until the end or the next marker when
   * `untilMarker` is set. Resolves `"stopped"` at once when `replay` is no longer on screen.
   */
  run(replay: LoadedReplay, speed: ReplaySpeed, untilMarker: boolean): Promise<ReplayStop> {
    if (replay !== this.loaded) {
      return Promise.resolve("stopped");
    }
    return replay.player.run(speed, untilMarker);
  }

  /** Runs `operation` once every earlier queued operation has settled. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(operation);
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  /** Stops the replay on screen, if any, and gives the screen back. */
  private async end(): Promise<void> {
    const ending = this.loaded;
    this.loaded = undefined;
    if (ending) {
      await ending.player.stop();
      this.hooks.release();
    }
  }
}
