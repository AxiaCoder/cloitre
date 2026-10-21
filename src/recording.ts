import { invoke } from "@tauri-apps/api/core";

import type { PtySession } from "./pty";

/** Record type of an output chunk, as written by Rust. */
const KIND_OUTPUT = 1;
/** Record type of a terminal size, as written by Rust. */
const KIND_RESIZE = 2;
/** Record type of a marker, as written by Rust. */
const KIND_MARKER = 3;
/** Size of a record header: time (u64), type (u8), length (u32). */
const HEADER_SIZE = 13;

/** One record of a recording. `at` is in milliseconds since the session started. */
export type RecordingEvent =
  | { readonly kind: "output"; readonly at: number; readonly data: Uint8Array }
  | { readonly kind: "resize"; readonly at: number; readonly cols: number; readonly rows: number }
  | { readonly kind: "marker"; readonly at: number };

/** A decoded recording. `truncated` is true when the file ends in the middle of a record. */
export interface DecodedRecording {
  readonly events: readonly RecordingEvent[];
  readonly truncated: boolean;
}

/** A recording file, as listed by Rust. */
export interface RecordingInfo {
  readonly name: string;
  /** File size, in bytes. */
  readonly size: number;
}

/**
 * Decodes a recording file: records `[ms: u64][type: u8][length: u32][data]`,
 * little-endian. An incomplete last record is dropped and flagged as truncated.
 * Throws on an unknown record type or a resize record of the wrong length.
 */
export function decodeRecording(bytes: Uint8Array): DecodedRecording {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events: RecordingEvent[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + HEADER_SIZE > bytes.length) {
      return { events, truncated: true };
    }
    const at = Number(view.getBigUint64(offset, true));
    const kind = view.getUint8(offset + 8);
    const length = view.getUint32(offset + 9, true);
    const start = offset + HEADER_SIZE;
    if (start + length > bytes.length) {
      return { events, truncated: true };
    }
    if (kind === KIND_OUTPUT) {
      events.push({ kind: "output", at, data: bytes.slice(start, start + length) });
    } else if (kind === KIND_RESIZE) {
      if (length !== 4) {
        throw new Error(`resize record of ${String(length)} bytes at offset ${String(offset)}`);
      }
      events.push({ kind: "resize", at, cols: view.getUint16(start, true), rows: view.getUint16(start + 2, true) });
    } else if (kind === KIND_MARKER) {
      events.push({ kind: "marker", at });
    } else {
      throw new Error(`unknown record type ${String(kind)} at offset ${String(offset)}`);
    }
    offset = start + length;
  }
  return { events, truncated: false };
}

/** Where a replay draws: in the app, the xterm.js terminal. */
export interface ReplayTarget {
  /** Clears the screen and every terminal state. */
  reset(): void;
  /** Sets the terminal grid to `cols` x `rows`. */
  resize(cols: number, rows: number): void;
  /** Queues one chunk of output bytes. */
  write(data: Uint8Array): void;
  /** Resolves once every queued chunk has been processed. */
  drained(): Promise<void>;
}

/** Waits `ms` milliseconds, or less when `signal` aborts. */
export type Wait = (ms: number, signal: AbortSignal) => Promise<void>;

/** How fast a replay goes: every record at once, or with the recorded delays. */
export type ReplaySpeed = "instant" | "realtime";

/** Where a replay run stopped: at the end, on a marker, or because it was stopped. */
export type ReplayStop = "end" | "marker" | "stopped";

/** Waits with `setTimeout`, cut short when `signal` aborts. */
function waitWithTimer(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    /** Resolves once, whichever comes first. */
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Replays decoded records into a target, without any pseudo-terminal. Output
 * chunks are written one by one, in the recorded split; resizes are applied to
 * the target once every earlier chunk has been processed. Runs resume from
 * where the previous one paused; a new run stops the one still going.
 */
export class Replay {
  private position = 0;
  private started = false;
  private controller: AbortController | undefined;
  private running: Promise<unknown> = Promise.resolve();

  /** Prepares a replay of `events` into `target`; `wait` paces the real-time speed. */
  constructor(
    private readonly events: readonly RecordingEvent[],
    private readonly target: ReplayTarget,
    private readonly wait: Wait = waitWithTimer,
  ) {}

  /** Tells whether every record has been replayed. */
  get finished(): boolean {
    return this.position >= this.events.length;
  }

  /**
   * Replays from the current position at `speed`, until the end or, when
   * `untilMarker` is set, until the next marker included. The first run resets
   * the target. Resolves once the target has processed what was written.
   */
  async run(speed: ReplaySpeed, untilMarker: boolean): Promise<ReplayStop> {
    this.controller?.abort();
    await this.running;
    const controller = new AbortController();
    this.controller = controller;
    const run = this.play(speed, untilMarker, controller.signal);
    this.running = run.catch(() => undefined);
    return run;
  }

  /** Stops the run still going, if any. Resolves once it has stopped. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }

  /** Plays records until the end, a marker when `untilMarker` is set, or `signal` aborts. */
  private async play(speed: ReplaySpeed, untilMarker: boolean, signal: AbortSignal): Promise<ReplayStop> {
    if (!this.started) {
      this.started = true;
      this.target.reset();
    }
    let previousAt = this.events[this.position]?.at ?? 0;
    while (this.position < this.events.length) {
      const event = this.events[this.position];
      if (speed === "realtime" && event.at > previousAt) {
        await this.target.drained();
        await this.wait(event.at - previousAt, signal);
      }
      if (signal.aborted) {
        return "stopped";
      }
      previousAt = event.at;
      this.position += 1;
      if (event.kind === "output") {
        this.target.write(event.data);
      } else if (event.kind === "resize") {
        await this.target.drained();
        this.target.resize(event.cols, event.rows);
      } else if (untilMarker) {
        await this.target.drained();
        return "marker";
      }
    }
    await this.target.drained();
    return "end";
  }
}

/** Lists the recording files, newest first. */
export function listRecordings(): Promise<RecordingInfo[]> {
  return invoke("recording_list");
}

/** Reads the raw bytes of recording `name`. Rejects with the Rust refusal message. */
export async function readRecording(name: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("recording_read", { name }));
}

/** Writes a marker in the recording of `session`. Rejects when it is not recorded. */
export function markRecording(session: PtySession): Promise<void> {
  return invoke("recording_mark", { id: session.id });
}

/** Returns the file name of the recording of `session`, or `null` when it is not recorded. */
export function currentRecording(session: PtySession): Promise<string | null> {
  return invoke("recording_current", { id: session.id });
}
