import { Channel, invoke } from "@tauri-apps/api/core";

/** A running `claude` session on the Rust side. */
export interface PtySession {
  readonly id: number;
}

/** Callbacks a session reports to. */
export interface PtyHandlers {
  /** Receives every chunk of raw output bytes, in order. */
  onOutput: (bytes: Uint8Array) => void;
  /** Receives the exit code once, when `claude` ends. */
  onExit: (code: number) => void;
}

/**
 * Converts a channel payload to bytes. Raw payloads arrive as an `ArrayBuffer`,
 * JSON ones as an array of numbers.
 */
function toBytes(payload: ArrayBuffer | number[]): Uint8Array {
  return payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload);
}

/**
 * Starts `claude` in `folder` with a terminal of `cols` x `rows`.
 * Rejects with the Rust refusal message when the folder or the size is refused.
 */
export async function spawnPty(
  folder: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
): Promise<PtySession> {
  const onOutput = new Channel<ArrayBuffer | number[]>();
  onOutput.onmessage = (payload) => {
    handlers.onOutput(toBytes(payload));
  };
  const onExit = new Channel<number>();
  onExit.onmessage = handlers.onExit;
  const id = await invoke<number>("pty_spawn", { folder, cols, rows, onOutput, onExit });
  return { id };
}

/** Sends keyboard input to the session. */
export function writePty(session: PtySession, data: string): Promise<void> {
  return invoke("pty_write", { id: session.id, data });
}

/** Resizes the session's terminal to `cols` x `rows`. */
export function resizePty(session: PtySession, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id: session.id, cols, rows });
}

/** Stops the session and releases it on the Rust side. */
export function killPty(session: PtySession): Promise<void> {
  return invoke("pty_kill", { id: session.id });
}
