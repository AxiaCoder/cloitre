import { invoke } from "@tauri-apps/api/core";

import type { KeepAwake } from "./settings";

/** What keeping the computer awake needs to know of a session tab. */
export interface SessionWork {
  /** Whether the session works, even while one of its subagents waits for an answer. */
  working: boolean;
  /** Whether the session, or one of its subagents, waits for an answer. */
  blocked: boolean;
}

/**
 * Returns whether the computer should be kept from sleeping under choice
 * `setting`, given every session tab: `"working"` asks for a working session,
 * `"working-or-blocked"` for one working or waiting for an answer, `"never"`
 * for nothing.
 */
export function shouldKeepAwake(setting: KeepAwake, sessions: Iterable<SessionWork>): boolean {
  if (setting === "never") {
    return false;
  }
  for (const session of sessions) {
    if (session.working || (setting === "working-or-blocked" && session.blocked)) {
      return true;
    }
  }
  return false;
}

/**
 * Asks Rust to keep the system from sleeping (`on`) or to let it sleep again.
 * The screen may still turn off. Does nothing outside Windows.
 */
export function keepAwake(on: boolean): Promise<void> {
  return invoke("keep_awake", { on });
}

/**
 * Sends Rust the keep-awake state only when it changes, each send after the
 * previous one has settled, so Rust gets the states in order. The first state
 * is always sent, so a reloaded webview drops a request a previous one left.
 */
export class KeepAwakeSync {
  private sent: boolean | undefined;
  private previous: Promise<unknown> = Promise.resolve();

  /** @param send sends a state to Rust; a failed send is not retried until the state changes */
  constructor(private readonly send: (on: boolean) => Promise<void>) {}

  /** Sends `on` unless it is the state last sent; resolves once sent, rejects when the send fails. */
  update(on: boolean): Promise<void> {
    if (this.sent === on) {
      return Promise.resolve();
    }
    this.sent = on;
    const sending = this.previous.catch(() => undefined).then(() => this.send(on));
    this.previous = sending;
    return sending;
  }
}
