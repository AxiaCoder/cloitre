/**
 * What a session tab's `claude` session is doing, as the `session-state` event
 * Rust emits tells it, and what the tab bar and the project rail show of it.
 */

/** What a tab shows of its session: `"blocked"` waits for the user's answer, `"done"` finished a turn not seen yet. */
export type SessionActivity = "blocked" | "done";

/** A session state Rust reports for a tab. */
export type ReportedState = "blocked" | "working" | "done";

/** One `session-state` event: the tab it is about and the state its session reports. */
export interface ActivityReport {
  readonly tab: number;
  readonly state: ReportedState;
}

/** The session states this version understands; any other is ignored. */
const REPORTED_STATES: readonly string[] = ["blocked", "working", "done"] satisfies readonly ReportedState[];

/**
 * Reads the payload of a `session-state` event. Returns `undefined` for a
 * payload that is not `{ tab, state }` with a whole tab id of 1 or more and a
 * state this version understands.
 */
export function parseActivityReport(payload: unknown): ActivityReport | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { tab, state } = payload as Record<string, unknown>;
  if (typeof tab !== "number" || !Number.isInteger(tab) || tab < 1) {
    return undefined;
  }
  if (typeof state !== "string" || !REPORTED_STATES.includes(state)) {
    return undefined;
  }
  return { tab, state: state as ReportedState };
}

/** The activity of every session tab that shows one, by tab id. */
export class ActivityStore {
  /** The activity of each tab that shows one; a tab absent shows nothing. */
  private readonly activities = new Map<number, SessionActivity>();

  /**
   * Applies the state `state` reported for tab `tabId`. `seen` tells whether
   * that tab is on screen in the focused window: a `"done"` it sees shows
   * nothing. `"blocked"` shows whatever is on screen; `"working"` clears the
   * activity. Returns whether the tab's activity changed.
   */
  report(tabId: number, state: ReportedState, seen: boolean): boolean {
    if (state === "blocked") {
      return this.set(tabId, "blocked");
    }
    if (state === "done" && !seen) {
      return this.set(tabId, "done");
    }
    return this.forget(tabId);
  }

  /** Marks tab `tabId` as seen on screen in the focused window: a `"done"` goes out, a `"blocked"` stays. Returns whether it changed. */
  see(tabId: number): boolean {
    return this.activities.get(tabId) === "done" && this.forget(tabId);
  }

  /** Forgets the activity of tab `tabId`, closed or whose session ended or restarts. Returns whether it had one. */
  forget(tabId: number): boolean {
    return this.activities.delete(tabId);
  }

  /** Returns the activity of tab `tabId`, or `undefined` when it shows none. */
  of(tabId: number): SessionActivity | undefined {
    return this.activities.get(tabId);
  }

  /** Returns the most urgent activity of tabs `tabIds`, `"blocked"` before `"done"`, or `undefined` when none shows one. */
  mostUrgent(tabIds: Iterable<number>): SessionActivity | undefined {
    let found: SessionActivity | undefined;
    for (const tabId of tabIds) {
      const activity = this.activities.get(tabId);
      if (activity === "blocked") {
        return activity;
      }
      found ??= activity;
    }
    return found;
  }

  /** Sets the activity of tab `tabId` to `activity`. Returns whether it changed. */
  private set(tabId: number, activity: SessionActivity): boolean {
    if (this.activities.get(tabId) === activity) {
      return false;
    }
    this.activities.set(tabId, activity);
    return true;
  }
}
