/**
 * Which session tabs are idle, and the clock that says when an idle tab has
 * been idle for the delay the settings give.
 */

import type { IdleDelay } from "./settings";
import type { SessionActivity } from "./session-activity";
import type { TabState } from "./tabs";

/**
 * Returns whether a session tab in `state`, whose session shows `activity`,
 * is idle: its session runs and shows no activity. A session that waits for
 * an answer, stopped on an error, finished a turn not seen yet or works,
 * background tasks included, is not idle; nor is one still starting.
 */
export function isIdle(state: TabState | undefined, activity: SessionActivity | undefined): boolean {
  return state === "running" && activity === undefined;
}

/**
 * Times how long each idle session tab has been idle, and calls `onIdle` with
 * a tab id once that tab has been idle for the delay. A tab is timed from the
 * moment it is first listed idle; {@link IdleClock.touch} restarts its time.
 * With the delay `"never"`, no tab is ever reported.
 */
export class IdleClock {
  private readonly idleSince = new Map<number, number>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Creates a clock with `delay`, timing no tab yet. */
  constructor(
    private delay: IdleDelay,
    private readonly onIdle: (tabId: number) => void,
  ) {}

  /**
   * Takes `idleTabIds` as every idle tab now: starts timing those not timed
   * yet, keeps the time of those already timed, and stops timing the others.
   */
  sync(idleTabIds: Iterable<number>): void {
    const idle = new Set(idleTabIds);
    for (const tabId of this.idleSince.keys()) {
      if (!idle.has(tabId)) {
        this.drop(tabId);
      }
    }
    for (const tabId of idle) {
      if (!this.idleSince.has(tabId)) {
        this.idleSince.set(tabId, Date.now());
        this.schedule(tabId);
      }
    }
  }

  /** Restarts the time of tab `tabId` from now, when it is timed; does nothing otherwise. */
  touch(tabId: number): void {
    if (this.idleSince.has(tabId)) {
      this.idleSince.set(tabId, Date.now());
      this.schedule(tabId);
    }
  }

  /**
   * Makes `delay` the delay of every timed tab, counted from its last activity:
   * a tab whose last activity is older than `delay` is reported at once.
   */
  setDelay(delay: IdleDelay): void {
    this.delay = delay;
    for (const tabId of this.idleSince.keys()) {
      this.schedule(tabId);
    }
  }

  /** Sets, or clears under `"never"`, the timer of timed tab `tabId`, replacing any it had. */
  private schedule(tabId: number): void {
    clearTimeout(this.timers.get(tabId));
    this.timers.delete(tabId);
    const since = this.idleSince.get(tabId);
    if (since === undefined || this.delay === "never") {
      return;
    }
    const remaining = Math.max(0, since + this.delay * 60_000 - Date.now());
    this.timers.set(
      tabId,
      setTimeout(() => {
        this.drop(tabId);
        this.onIdle(tabId);
      }, remaining),
    );
  }

  /** Stops timing tab `tabId`. */
  private drop(tabId: number): void {
    clearTimeout(this.timers.get(tabId));
    this.timers.delete(tabId);
    this.idleSince.delete(tabId);
  }
}
