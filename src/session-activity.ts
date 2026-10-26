/**
 * What a session tab's `claude` session is doing, as the `session-state` event
 * Rust emits tells it, and what the tab bar and the project rail show of it.
 */

/** What a tab shows of its session: `"blocked"` waits for the user's answer, `"done"` finished a turn not seen yet. */
export type SessionActivity = "blocked" | "done";

/** A session state Rust reports for a tab; `"prompted"` means the user sent a prompt, which ends every wait. */
export type ReportedState = "blocked" | "prompted" | "working" | "done";

/** One `session-state` event: the tab it is about, the state its session reports and, for a subagent, its id. */
export interface ActivityReport {
  readonly tab: number;
  readonly state: ReportedState;
  readonly agent?: string;
}

/** The session states this version understands; any other is ignored. */
const REPORTED_STATES: readonly string[] = ["blocked", "prompted", "working", "done"] satisfies readonly ReportedState[];

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
 * The activity of every session tab that shows one, by tab id. A tab is
 * blocked while one of its agents waits for the user, the main conversation
 * or a subagent; blocked outranks done.
 */
export class ActivityStore {
  /** The agents that block each tab, the main conversation as {@link MAIN_AGENT}; a tab absent is not blocked. */
  private readonly blocks = new Map<number, Set<string>>();
  /** The tabs that finished a turn not seen yet. */
  private readonly done = new Set<number>();

  /**
   * Applies the state `state` reported for tab `tabId` by subagent `agent`, or
   * by the main conversation when `agent` is `undefined`. `seen` tells whether
   * that tab is on screen in the focused window: a `"done"` it sees shows
   * nothing. `"blocked"` blocks the tab for that agent; `"working"` and
   * `"done"` end that agent's block only; `"prompted"` ends every block of the
   * tab. Returns whether the tab's activity changed.
   */
  report(tabId: number, state: ReportedState, seen: boolean, agent?: string): boolean {
    const before = this.of(tabId);
    const key = agent ?? MAIN_AGENT;
    if (state === "blocked") {
      const agents = this.blocks.get(tabId) ?? new Set<string>();
      agents.add(key);
      this.blocks.set(tabId, agents);
      this.done.delete(tabId);
    } else if (state === "prompted") {
      this.blocks.delete(tabId);
      this.done.delete(tabId);
    } else {
      this.unblock(tabId, key);
      if (state === "done" && !seen) {
        this.done.add(tabId);
      } else {
        this.done.delete(tabId);
      }
    }
    return this.of(tabId) !== before;
  }

  /** Ends every block of tab `tabId`, whose user just answered from the keyboard. Returns whether it was blocked. */
  answer(tabId: number): boolean {
    return this.blocks.delete(tabId);
  }

  /** Marks tab `tabId` as seen on screen in the focused window: a `"done"` goes out, a `"blocked"` stays. Returns whether it changed. */
  see(tabId: number): boolean {
    return this.of(tabId) === "done" && this.done.delete(tabId);
  }

  /** Forgets the activity of tab `tabId`, closed or whose session ended or restarts. Returns whether it had one. */
  forget(tabId: number): boolean {
    const blocked = this.blocks.delete(tabId);
    const done = this.done.delete(tabId);
    return blocked || done;
  }

  /** Returns the activity of tab `tabId`, or `undefined` when it shows none. */
  of(tabId: number): SessionActivity | undefined {
    if (this.blocks.has(tabId)) {
      return "blocked";
    }
    return this.done.has(tabId) ? "done" : undefined;
  }

  /** Returns the most urgent activity of tabs `tabIds`, `"blocked"` before `"done"`, or `undefined` when none shows one. */
  mostUrgent(tabIds: Iterable<number>): SessionActivity | undefined {
    let found: SessionActivity | undefined;
    for (const tabId of tabIds) {
      const activity = this.of(tabId);
      if (activity === "blocked") {
        return activity;
      }
      found ??= activity;
    }
    return found;
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
