import { messages } from "./strings";
import { cleanTitle } from "./tab-title";

/**
 * Where a session tab's `claude` session stands. `"restored"` is a tab reopened
 * from a previous run, waiting for the user to resume or start a session;
 * `"failed"` is a tab whose last start Rust refused.
 */
export type TabState = "restored" | "starting" | "running" | "exited" | "failed";

/** What to do with a session tab once its start did not end in a running session. */
export type RefusedStartOutcome = "keep" | "restore" | "close";

/**
 * Decides what becomes of a session tab whose start did not end in a running
 * session. `stateNow` is the tab's state now, `undefined` when it is gone or no
 * longer a session tab; `previous` is its state before the start, `undefined`
 * for a tab opened for that start.
 * - `"keep"`: leave the tab as it is (gone, failed with its error shown, or
 *   moved on by another start or a stop).
 * - `"restore"`: put the tab back in `previous`; only for a tab that existed
 *   before and is still `"starting"`.
 * - `"close"`: close the tab; only for a tab opened for that start and not
 *   `"failed"`.
 */
export function afterRefusedStart(
  stateNow: TabState | undefined,
  previous: TabState | undefined,
): RefusedStartOutcome {
  if (stateNow === undefined) {
    return "keep";
  }
  if (previous === undefined) {
    return stateNow === "failed" ? "keep" : "close";
  }
  return stateNow === "starting" ? "restore" : "keep";
}

/** One tab of a project running a `claude` session in its terminal. */
export interface SessionTab {
  readonly kind: "session";
  /** The tab id Rust gave it: unique across every project, from 1, never reused. */
  readonly id: number;
  readonly projectId: number;
  /** "Session N", numbered within its project. */
  readonly label: string;
  /** The title its session set, cleaned by {@link cleanTitle}, or `null` when it set none. */
  readonly title: string | null;
  readonly state: TabState;
}

/** A session tab saved by a previous run: its id and the title its session last set. */
export interface SavedTab {
  readonly id: number;
  readonly title: string | null;
}

/** Returns the full name of `tab`: its session's title when it has one, else its label. */
export function tabName(tab: Tab): string {
  return (tab.kind === "session" ? tab.title : null) ?? tab.label;
}

/** One tab of a project replaying a recording, with no session behind it. */
export interface ReplayTab {
  readonly kind: "replay";
  /** Negative, so it never meets a session tab id; never reused. */
  readonly id: number;
  readonly projectId: number;
  /** "Replay <recording>". */
  readonly label: string;
  /** The name of the recording it replays. */
  readonly recording: string;
}

/** One tab of a project: a session tab or a replay tab. */
export type Tab = SessionTab | ReplayTab;

/**
 * Whether a project is paused: its folder exists and none of `tabs`, its tabs,
 * is a session tab `"starting"` or `"running"`. A project with no tab is
 * paused; a replay tab never keeps it awake; a missing project is never paused.
 */
export function isProjectPaused(exists: boolean, tabs: readonly Tab[]): boolean {
  return exists && !tabs.some((tab) => tab.kind === "session" && (tab.state === "starting" || tab.state === "running"));
}

/** `T` with every property writable. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** A tab as the model stores it, with the fields that change over time writable. */
type StoredTab = Writable<SessionTab> | Writable<ReplayTab>;

/** What closing a tab did: the tab removed and its project's active tab afterwards. */
export interface ClosedTab {
  readonly closed: Tab;
  readonly active: Tab | undefined;
}

/**
 * The tabs of every project, in opening order, with one active tab per project.
 * Holds no DOM, no session and no replay: only ids, kinds, labels, states and
 * which tab is active.
 */
export class TabModel {
  private readonly tabs: StoredTab[] = [];
  private readonly activeIds = new Map<number, number>();
  private readonly lastNumbers = new Map<number, number>();
  private nextReplayId = -1;

  /**
   * Opens session tab `id` (the id Rust gave it) for project `projectId`, in the
   * `"starting"` state, and makes it the project's active tab. Its label number
   * follows the highest one the project has used, even after closes; replay
   * tabs do not count.
   */
  open(projectId: number, id: number): SessionTab {
    const tab = this.addSession(projectId, id, "starting");
    this.activeIds.set(projectId, tab.id);
    return tab;
  }

  /**
   * Reopens the session tabs `saved` of project `projectId`, from a previous
   * run, in that order and in the `"restored"` state, labelled as {@link open}
   * does and with their saved title, cleaned by {@link cleanTitle}. When the
   * project has no active tab, `activeId` becomes it if it is one of `saved`,
   * else the first of `saved`.
   */
  restore(projectId: number, saved: readonly SavedTab[], activeId?: number): SessionTab[] {
    const restored = saved.map(({ id, title }) =>
      this.addSession(projectId, id, "restored", title === null ? null : cleanTitle(title)),
    );
    if (restored.length > 0 && !this.activeIds.has(projectId)) {
      const active = restored.find((tab) => tab.id === activeId) ?? restored[0];
      this.activeIds.set(projectId, active.id);
    }
    return restored;
  }

  /**
   * Shows recording `recording` in the replay tab of project `projectId`: reuses
   * the project's replay tab when it has one, relabelled, else opens a new one.
   * Either way the tab becomes the project's active tab.
   */
  openReplay(projectId: number, recording: string): ReplayTab {
    const label = messages.replayLabel(recording);
    const existing = this.tabs.find((tab) => tab.kind === "replay" && tab.projectId === projectId);
    if (existing?.kind === "replay") {
      existing.recording = recording;
      existing.label = label;
      this.activeIds.set(projectId, existing.id);
      return existing;
    }
    const tab: StoredTab = { kind: "replay", id: this.nextReplayId, projectId, label, recording };
    this.nextReplayId -= 1;
    this.tabs.push(tab);
    this.activeIds.set(projectId, tab.id);
    return tab;
  }

  /**
   * Closes tab `tabId`. When it was its project's active tab, the tab that took
   * its place becomes active, else the one before it, else none.
   * Returns `undefined` when no tab has that id.
   */
  close(tabId: number): ClosedTab | undefined {
    const closed = this.find(tabId);
    if (!closed) {
      return undefined;
    }
    const siblings = this.tabsOf(closed.projectId);
    const index = siblings.indexOf(closed);
    this.tabs.splice(this.tabs.indexOf(closed), 1);
    if (this.activeIds.get(closed.projectId) === tabId) {
      const neighbourIndex = index + 1 < siblings.length ? index + 1 : index - 1;
      const neighbour = neighbourIndex >= 0 ? siblings[neighbourIndex] : undefined;
      if (neighbour) {
        this.activeIds.set(closed.projectId, neighbour.id);
      } else {
        this.activeIds.delete(closed.projectId);
      }
    }
    return { closed, active: this.activeOf(closed.projectId) };
  }

  /** Makes tab `tabId` its project's active tab. Does nothing for an unknown id. */
  activate(tabId: number): void {
    const tab = this.find(tabId);
    if (tab) {
      this.activeIds.set(tab.projectId, tab.id);
    }
  }

  /** Sets the state of session tab `tabId`. Does nothing for an unknown id or a replay tab. */
  setState(tabId: number, state: TabState): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.kind === "session") {
      tab.state = state;
    }
  }

  /**
   * Gives session tab `tabId` the title `raw` its session set, cleaned by
   * {@link cleanTitle}; `null` clears it. A title that holds no topic once
   * cleaned leaves the tab's title as it is. Returns the title it keeps when
   * that changed, else `undefined`, also for an unknown id or a replay tab.
   */
  setTitle(tabId: number, raw: string | null): { readonly title: string | null } | undefined {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    const title = raw === null ? null : cleanTitle(raw);
    if (tab?.kind !== "session" || tab.title === title || (raw !== null && title === null)) {
      return undefined;
    }
    tab.title = title;
    return { title };
  }

  /** Returns tab `tabId`, or `undefined` when no tab has that id. */
  find(tabId: number): Tab | undefined {
    return this.tabs.find((tab) => tab.id === tabId);
  }

  /** Returns the first replay tab, whatever its project, or `undefined` when there is none. */
  replayTab(): ReplayTab | undefined {
    return this.tabs.find((tab): tab is Writable<ReplayTab> => tab.kind === "replay");
  }

  /** Returns the tabs of project `projectId`, in opening order. */
  tabsOf(projectId: number): readonly Tab[] {
    return this.tabs.filter((tab) => tab.projectId === projectId);
  }

  /** Returns the active tab of project `projectId`, or `undefined` when it has none. */
  activeOf(projectId: number): Tab | undefined {
    const id = this.activeIds.get(projectId);
    return id === undefined ? undefined : this.find(id);
  }

  /** Appends session tab `id` of project `projectId` in `state`, with `title`, labelled with the project's next number. */
  private addSession(projectId: number, id: number, state: TabState, title: string | null = null): SessionTab {
    const number = (this.lastNumbers.get(projectId) ?? 0) + 1;
    this.lastNumbers.set(projectId, number);
    const tab: StoredTab = { kind: "session", id, projectId, label: messages.sessionLabel(number), title, state };
    this.tabs.push(tab);
    return tab;
  }
}
