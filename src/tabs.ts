/** Where a session tab's `claude` session stands. */
export type TabState = "starting" | "running" | "exited";

/** One tab of a project running a `claude` session in its terminal. */
export interface SessionTab {
  readonly kind: "session";
  /** Unique across every project, starting at 1, never reused. */
  readonly id: number;
  readonly projectId: number;
  /** "Session N", numbered within its project. */
  readonly label: string;
  readonly state: TabState;
}

/** One tab of a project replaying a recording, with no session behind it. */
export interface ReplayTab {
  readonly kind: "replay";
  /** Unique across every project, starting at 1, never reused. */
  readonly id: number;
  readonly projectId: number;
  /** "Replay <recording>". */
  readonly label: string;
  /** The name of the recording it replays. */
  readonly recording: string;
}

/** One tab of a project: a session tab or a replay tab. */
export type Tab = SessionTab | ReplayTab;

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
  private nextId = 1;

  /**
   * Opens a session tab for project `projectId`, in the `"starting"` state, and
   * makes it the project's active tab. Its label number follows the highest one
   * the project has used, even after closes; replay tabs do not count.
   */
  open(projectId: number): SessionTab {
    const number = (this.lastNumbers.get(projectId) ?? 0) + 1;
    this.lastNumbers.set(projectId, number);
    const tab: StoredTab = {
      kind: "session",
      id: this.takeId(),
      projectId,
      label: `Session ${String(number)}`,
      state: "starting",
    };
    this.tabs.push(tab);
    this.activeIds.set(projectId, tab.id);
    return tab;
  }

  /**
   * Shows recording `recording` in the replay tab of project `projectId`: reuses
   * the project's replay tab when it has one, relabelled, else opens a new one.
   * Either way the tab becomes the project's active tab.
   */
  openReplay(projectId: number, recording: string): ReplayTab {
    const label = `Replay ${recording}`;
    const existing = this.tabs.find((tab) => tab.kind === "replay" && tab.projectId === projectId);
    if (existing?.kind === "replay") {
      existing.recording = recording;
      existing.label = label;
      this.activeIds.set(projectId, existing.id);
      return existing;
    }
    const tab: StoredTab = { kind: "replay", id: this.takeId(), projectId, label, recording };
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

  /** Returns the next unused tab id. */
  private takeId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }
}
