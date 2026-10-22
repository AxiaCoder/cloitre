/** Where a tab's `claude` session stands. */
export type TabState = "starting" | "running" | "exited";

/** One tab of a project: one terminal, one `claude` session. */
export interface Tab {
  /** Unique across every project, starting at 1, never reused. */
  readonly id: number;
  readonly projectId: number;
  /** "Session N", numbered within its project. */
  readonly label: string;
  readonly state: TabState;
}

/** A tab as the model stores it, with a state that changes over time. */
interface StoredTab {
  readonly id: number;
  readonly projectId: number;
  readonly label: string;
  state: TabState;
}

/** What closing a tab did: the tab removed and its project's active tab afterwards. */
export interface ClosedTab {
  readonly closed: Tab;
  readonly active: Tab | undefined;
}

/**
 * The tabs of every project, in opening order, with one active tab per project.
 * Holds no DOM and no session: only ids, labels, states and which tab is active.
 */
export class TabModel {
  private readonly tabs: StoredTab[] = [];
  private readonly activeIds = new Map<number, number>();
  private readonly lastNumbers = new Map<number, number>();
  private nextId = 1;

  /**
   * Opens a tab for project `projectId`, in the `"starting"` state, and makes it
   * the project's active tab. Its label number follows the highest one the
   * project has used, even after closes.
   */
  open(projectId: number): Tab {
    const number = (this.lastNumbers.get(projectId) ?? 0) + 1;
    this.lastNumbers.set(projectId, number);
    const tab: StoredTab = { id: this.nextId, projectId, label: `Session ${String(number)}`, state: "starting" };
    this.nextId += 1;
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

  /** Sets the state of tab `tabId`. Does nothing for an unknown id. */
  setState(tabId: number, state: TabState): void {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      tab.state = state;
    }
  }

  /** Returns tab `tabId`, or `undefined` when no tab has that id. */
  find(tabId: number): Tab | undefined {
    return this.tabs.find((tab) => tab.id === tabId);
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
}
