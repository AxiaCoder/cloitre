/**
 * What a session tab's `claude` session is doing, as the `session-state` event
 * Rust emits tells it, and what the tab bar and the project rail show of it.
 */

/**
 * What a tab shows of its session: `"blocked"` waits for the user's answer,
 * `"failed"` ended its turn on an API error, `"done"` finished a turn not seen
 * yet, `"working"` works on a prompt or waits for its background tasks.
 */
export type SessionActivity = "blocked" | "failed" | "done" | "working";

/**
 * A session state Rust reports for a tab. `"prompted"` means the user sent a
 * prompt, which ends every wait; `"background"` that the turn ended while
 * background tasks still run; `"settled"` that a subagent ended and no
 * background task runs anymore; `"failed"` that the turn ended on an API error.
 */
export type ReportedState = "blocked" | "prompted" | "working" | "background" | "settled" | "done" | "failed";

/** One `session-state` event: the tab it is about, the state its session reports and, for a subagent, its id. */
export interface ActivityReport {
  readonly tab: number;
  readonly state: ReportedState;
  readonly agent?: string;
}

/** The session states this version understands; any other is ignored. */
const REPORTED_STATES: readonly string[] = [
  "blocked",
  "prompted",
  "working",
  "background",
  "settled",
  "done",
  "failed",
] satisfies readonly ReportedState[];

/** The activities of a tab, most urgent first. */
const URGENCY: readonly SessionActivity[] = ["blocked", "failed", "done", "working"];

/** What an agent id looks like: 1 to 64 ASCII letters, digits, `-` or `_`, as Rust checks it. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The key of the main conversation among the agents that block a tab. */
const MAIN_AGENT = "";

/**
 * Reads the payload of a `session-state` event. Returns `undefined` for a
 * payload that is not `{ tab, state }` with a whole tab id of 1 or more and a
 * state this version understands, plus maybe an `agent` that is an agent id.
 */
export function parseActivityReport(payload: unknown): ActivityReport | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { tab, state, agent } = payload as Record<string, unknown>;
  if (typeof tab !== "number" || !Number.isInteger(tab) || tab < 1) {
    return undefined;
  }
  if (typeof state !== "string" || !REPORTED_STATES.includes(state)) {
    return undefined;
  }
  if (agent === undefined) {
    return { tab, state: state as ReportedState };
  }
  if (typeof agent !== "string" || !AGENT_ID.test(agent)) {
    return undefined;
  }
  return { tab, state: state as ReportedState, agent };
}

/**
 * Returns whether `data`, input the user sends to a session's terminal, may
 * answer what the session waits for: it holds Enter (`\r`, so pasted text
 * holding one counts), is one digit, or is a lone Escape. An escape sequence
 * such as an arrow key is not an answer.
 */
export function isAnswerInput(data: string): boolean {
  return data.includes("\r") || data === "\x1b" || /^[0-9]$/.test(data);
}

/**
 * Returns whether `data`, input the user sends to a session's terminal,
 * interrupts the session: it is a lone Escape or a lone Ctrl+C. An escape
 * sequence such as an arrow key is not an interrupt.
 */
export function isInterruptInput(data: string): boolean {
  return data === "\x1b" || data === "\x03";
}

/**
 * The activity of every session tab that shows one, by tab id. A tab is
 * blocked while one of its agents waits for the user, the main conversation
 * or a subagent. A tab works from its prompt until its turn ends and, when the
 * turn left background tasks running, until they end too. On one tab as on a
 * set of tabs, blocked outranks failed, which outranks done, which outranks
 * working.
 */
export class ActivityStore {
  /** The agents that block each tab, the main conversation as {@link MAIN_AGENT}; a tab absent is not blocked. */
  private readonly blocks = new Map<number, Set<string>>();
  /** The tabs that finished a turn not seen yet. */
  private readonly done = new Set<number>();
  /** The tabs whose session works. */
  private readonly working = new Set<number>();
  /** The working tabs whose turn ended while background tasks still run. */
  private readonly awaiting = new Set<number>();
  /** The tabs whose last turn ended on an API error. */
  private readonly failed = new Set<number>();

  /**
   * Applies the state `state` reported for tab `tabId` by subagent `agent`, or
   * by the main conversation when `agent` is `undefined`. `seen` tells whether
   * that tab is on screen in the focused window: a turn it sees end shows
   * nothing. `"blocked"` blocks the tab for that agent; every other state ends
   * that agent's block, and `"prompted"` every block of the tab. `"prompted"`
   * and `"working"` make the tab work, and a `"working"` from the main
   * conversation ends the wait for background tasks; `"background"` keeps it working until a
   * `"settled"` or a `"done"`; `"settled"` is ignored for a tab not waiting for
   * its background tasks. `"failed"` shows until the next `"prompted"`.
   * Returns whether the tab's activity changed.
   */
  report(tabId: number, state: ReportedState, seen: boolean, agent?: string): boolean {
    const before = this.of(tabId);
    if (state === "blocked") {
      const agents = this.blocks.get(tabId) ?? new Set<string>();
      agents.add(agent ?? MAIN_AGENT);
      this.blocks.set(tabId, agents);
      this.done.delete(tabId);
    } else if (state === "prompted") {
      this.blocks.delete(tabId);
      this.done.delete(tabId);
      this.failed.delete(tabId);
      this.awaiting.delete(tabId);
      this.working.add(tabId);
    } else {
      this.unblock(tabId, agent ?? MAIN_AGENT);
      this.apply(tabId, state, seen, agent);
    }
    return this.of(tabId) !== before;
  }

  /** Ends every block of tab `tabId`, whose user just answered from the keyboard. Returns whether it was blocked. */
  answer(tabId: number): boolean {
    return this.blocks.delete(tabId);
  }

  /**
   * Ends the work and every block of tab `tabId`, whose user just interrupted
   * it from the keyboard, without showing it done. A tab that only waits for
   * its background tasks keeps working. Returns whether the tab's activity changed.
   */
  interrupt(tabId: number): boolean {
    if (this.awaiting.has(tabId)) {
      return false;
    }
    const before = this.of(tabId);
    this.blocks.delete(tabId);
    this.working.delete(tabId);
    return this.of(tabId) !== before;
  }

  /** Marks tab `tabId` as seen on screen in the focused window: a `"done"` goes out, any other activity stays. Returns whether it changed. */
  see(tabId: number): boolean {
    return this.of(tabId) === "done" && this.done.delete(tabId);
  }

  /** Forgets the activity of tab `tabId`, closed or whose session ended or restarts. Returns whether it had one. */
  forget(tabId: number): boolean {
    const had = this.of(tabId) !== undefined;
    this.blocks.delete(tabId);
    this.done.delete(tabId);
    this.working.delete(tabId);
    this.awaiting.delete(tabId);
    this.failed.delete(tabId);
    return had;
  }

  /** Returns the activity of tab `tabId`, the most urgent it has, or `undefined` when it shows none. */
  of(tabId: number): SessionActivity | undefined {
    if (this.blocks.has(tabId)) {
      return "blocked";
    }
    if (this.failed.has(tabId)) {
      return "failed";
    }
    if (this.done.has(tabId)) {
      return "done";
    }
    return this.working.has(tabId) ? "working" : undefined;
  }

  /** Returns the most urgent activity of tabs `tabIds`, blocked, failed, done then working, or `undefined` when none shows one. */
  mostUrgent(tabIds: Iterable<number>): SessionActivity | undefined {
    let found: SessionActivity | undefined;
    for (const tabId of tabIds) {
      const activity = this.of(tabId);
      if (activity !== undefined && (found === undefined || URGENCY.indexOf(activity) < URGENCY.indexOf(found))) {
        found = activity;
      }
    }
    return found;
  }

  /** Applies to tab `tabId` a state that neither blocks it nor starts a turn; `seen` and `agent` as in {@link report}. */
  private apply(
    tabId: number,
    state: Exclude<ReportedState, "blocked" | "prompted">,
    seen: boolean,
    agent: string | undefined,
  ): void {
    if (state === "working" || state === "background") {
      this.working.add(tabId);
      this.done.delete(tabId);
      if (state === "background") {
        this.awaiting.add(tabId);
      } else if (agent === undefined) {
        this.awaiting.delete(tabId);
      }
    } else if (state === "settled") {
      if (this.awaiting.has(tabId)) {
        this.finish(tabId, !seen);
      }
    } else if (state === "done") {
      this.finish(tabId, !seen);
    } else {
      this.finish(tabId, false);
      this.failed.add(tabId);
    }
  }

  /** Ends the work of tab `tabId`, and shows it done when `shown`. */
  private finish(tabId: number, shown: boolean): void {
    this.working.delete(tabId);
    this.awaiting.delete(tabId);
    if (shown) {
      this.done.add(tabId);
    } else {
      this.done.delete(tabId);
    }
  }

  /** Ends the block agent `key` holds on tab `tabId`, if any; the tab stays blocked while another agent blocks it. */
  private unblock(tabId: number, key: string): void {
    const agents = this.blocks.get(tabId);
    agents?.delete(key);
    if (agents?.size === 0) {
      this.blocks.delete(tabId);
    }
  }
}
