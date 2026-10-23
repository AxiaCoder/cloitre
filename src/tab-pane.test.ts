import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  interface Size {
    cols: number;
    rows: number;
  }

  /** Stand-in for an xterm.js addon: keeps the terminal it was loaded in. */
  class FakeAddon {
    terminal: FakeTerminal | undefined;
    /** Keeps the terminal, as xterm.js does when loading an addon. */
    activate(terminal: FakeTerminal): void {
      this.terminal = terminal;
    }
    /** Does nothing: there is nothing to free. */
    dispose(): void {
      return undefined;
    }
    /** Ignores the listener: the WebGL context is never lost here. */
    onContextLoss(): void {
      return undefined;
    }
  }

  /** Stand-in for the fit addon: resizes the grid to the container size, as xterm.js does. */
  class FakeFitAddon extends FakeAddon {
    /** Counts one fit and resizes the grid to the current container size. */
    fit(): void {
      state.fits += 1;
      this.terminal?.resizeTo(state.containerSize);
    }
  }

  /** Stand-in for the xterm.js terminal: records what it writes and lets the test type. */
  class FakeTerminal {
    cols = 80;
    rows = 24;
    unicode = { activeVersion: "6" };
    written: Uint8Array[] = [];
    resets = 0;
    disposed = false;
    dataListener: (data: string) => void = () => undefined;
    resizeListener: (size: Size) => void = () => undefined;
    keyHandler: (event: KeyboardEvent) => boolean = () => true;
    /** Registers the terminal, with its `options`, so the test can reach it. */
    constructor(readonly options: { disableStdin?: boolean } = {}) {
      state.terminals.push(this);
    }
    /** Activates `addon` on this terminal. */
    loadAddon(addon: FakeAddon): void {
      addon.activate(this);
    }
    /** Does nothing: there is no screen to attach to. */
    open(): void {
      return undefined;
    }
    /** Keeps the input listener. */
    onData(listener: (data: string) => void): void {
      this.dataListener = listener;
    }
    /** Keeps the resize listener. */
    onResize(listener: (size: Size) => void): void {
      this.resizeListener = listener;
    }
    /** Keeps the key handler. */
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      this.keyHandler = handler;
    }
    /** Records the bytes written to the screen. */
    write(bytes: Uint8Array): void {
      this.written.push(bytes);
    }
    /** Counts one reset. */
    reset(): void {
      this.resets += 1;
    }
    /** Does nothing: there is no screen to redraw. */
    refresh(): void {
      return undefined;
    }
    /** Records the disposal. */
    dispose(): void {
      this.disposed = true;
    }
    /** Changes the grid size and tells the resize listener, only when it changed. */
    resizeTo(size: Size): void {
      if (size.cols === this.cols && size.rows === this.rows) {
        return;
      }
      this.cols = size.cols;
      this.rows = size.rows;
      this.resizeListener({ ...size });
    }
  }

  const state = {
    terminals: [] as FakeTerminal[],
    fits: 0,
    containerSize: { cols: 100, rows: 30 },
  };
  return { FakeAddon, FakeFitAddon, FakeTerminal, state };
});

const tauri = vi.hoisted(() => {
  /** Stand-in for the Tauri IPC channel: the test pushes messages through `onmessage`. */
  class FakeChannel {
    onmessage: (payload: never) => void = () => undefined;
  }
  return { FakeChannel, invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>() };
});

vi.mock("@xterm/xterm", () => ({ Terminal: fakes.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: fakes.FakeFitAddon }));
vi.mock("@xterm/addon-unicode-graphemes", () => ({ UnicodeGraphemesAddon: fakes.FakeAddon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: fakes.FakeAddon }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: tauri.FakeChannel, invoke: tauri.invoke }));

import { ReplayPane, TabPane, type TabPaneHandlers } from "./tab-pane";

/** Stand-in for a DOM element: keeps its children, attributes and click listeners. */
class FakeElement {
  className = "";
  hidden = false;
  textContent = "";
  type = "";
  parent: FakeElement | undefined;
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  private readonly clickListeners: (() => void)[] = [];
  /** Creates an element of tag `tagName`. */
  constructor(readonly tagName: string) {}
  /** Appends `nodes` as children. */
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  /** Removes the element from its parent. */
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = undefined;
    }
  }
  /** Keeps a click listener. */
  addEventListener(type: string, listener: () => void): void {
    if (type === "click") {
      this.clickListeners.push(listener);
    }
  }
  /** Sets attribute `name`. */
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  /** Fires the click listeners. */
  click(): void {
    for (const listener of this.clickListeners) {
      listener();
    }
  }
}

interface SpawnArgs {
  mode: string;
  tabId: number;
  cols: number;
  rows: number;
  onOutput: { onmessage: (payload: number[]) => void };
  onExit: { onmessage: (code: number) => void };
}

let nextId: number;
let spawns: SpawnArgs[];
let observers: (() => void)[];
let parent: FakeElement;

/** The arguments of every `invoke` call of `command` made so far. */
function calls(command: string): unknown[] {
  return tauri.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

/** Handlers that record what the pane tells the page. */
function recorder() {
  const events: string[] = [];
  const handlers: TabPaneHandlers = {
    onExit: (code) => events.push(`exit ${String(code)}`),
    onError: (error) => events.push(`error ${String(error)}`),
    onMarkKey: () => events.push("mark"),
    onRestart: () => events.push("restart"),
    onResume: () => events.push("resume"),
    onClose: () => events.push("close"),
  };
  return { events, handlers };
}

/** The pane's container, as the fake element it is. */
function containerOf(pane: TabPane | ReplayPane): FakeElement {
  return pane.container as unknown as FakeElement;
}

/** The end notice of `pane`, with its text and its Restart and Close buttons. */
function endNoticeOf(pane: TabPane) {
  const notice = containerOf(pane).children.find((child) => child.className === "end-notice");
  if (!notice) {
    throw new Error("no end notice");
  }
  const [text, restart, close] = notice.children;
  return { notice, text, restart, close };
}

/** The start notice of `pane`, with its text and its Resume and New session buttons. */
function startNoticeOf(pane: TabPane) {
  const notice = containerOf(pane).children.find((child) => child.className === "start-notice");
  if (!notice) {
    throw new Error("no start notice");
  }
  const [text, resume, newSession] = notice.children;
  return { notice, text, resume, newSession };
}

/** The terminal the pane drew. */
function terminalOf(pane: TabPane | ReplayPane): InstanceType<typeof fakes.FakeTerminal> {
  return pane.view.terminal as unknown as InstanceType<typeof fakes.FakeTerminal>;
}

/** Opens a session tab `tabId` in the fake parent. */
function openPane(tabId: number, handlers: TabPaneHandlers): TabPane {
  return new TabPane(parent as unknown as HTMLElement, tabId, handlers);
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  fakes.state.terminals = [];
  fakes.state.fits = 0;
  fakes.state.containerSize = { cols: 100, rows: 30 };
  nextId = 1;
  spawns = [];
  observers = [];
  parent = new FakeElement("main");
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation((command, args) => {
    if (command === "pty_spawn") {
      spawns.push(args as SpawnArgs);
      return Promise.resolve(nextId++);
    }
    return Promise.resolve();
  });
  vi.stubGlobal("document", { createElement: (tagName: string) => new FakeElement(tagName) });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      /** Registers the observer so the test can fire it. */
      constructor(callback: () => void) {
        observers.push(callback);
      }
      /** Does nothing: the test fires the observer by hand. */
      observe(): void {
        return undefined;
      }
      /** Does nothing: nothing is observed for real. */
      disconnect(): void {
        return undefined;
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TabPane.start", () => {
  it("spawns claude for its tab id on a cleared screen fitted to its container", async () => {
    const pane = openPane(7, recorder().handlers);
    expect(await pane.start("new")).toBe(true);
    expect(terminalOf(pane).resets).toBe(1);
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ tabId: 7, mode: "new", cols: 100, rows: 30 });
    expect(containerOf(pane).parent).toBe(parent);
  });

  it("writes the session output to its own terminal", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    spawns[0].onOutput.onmessage([104, 105]);
    expect(terminalOf(pane).written.map((bytes) => [...bytes])).toEqual([[104, 105]]);
  });

  it("keeps writing output while hidden", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    pane.hide();
    spawns[0].onOutput.onmessage([65]);
    expect(containerOf(pane).hidden).toBe(true);
    expect(terminalOf(pane).written).toHaveLength(1);
  });
});

describe("TabPane, when claude ends", () => {
  it("shows the end notice with the exit code and tells the page", async () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    await pane.start("new");
    expect(endNoticeOf(pane).notice.hidden).toBe(true);
    spawns[0].onExit.onmessage(3);
    const { notice, text } = endNoticeOf(pane);
    expect(notice.hidden).toBe(false);
    expect(text.textContent).toBe("Claude Code ended (code 3)");
    expect(events).toEqual(["exit 3"]);
  });

  it("asks the page to restart or to close from the notice buttons", async () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    await pane.start("new");
    spawns[0].onExit.onmessage(0);
    const { restart, close } = endNoticeOf(pane);
    expect(restart.textContent).toBe("Restart");
    expect(close.textContent).toBe("Close");
    restart.click();
    close.click();
    expect(events).toEqual(["exit 0", "restart", "close"]);
  });

  it("restarts in the same tab with the same tab id and hides the notice", async () => {
    const pane = openPane(4, recorder().handlers);
    await pane.start("new");
    spawns[0].onExit.onmessage(1);
    await settle();
    expect(await pane.start("new")).toBe(true);
    expect(spawns.map((spawn) => spawn.tabId)).toEqual([4, 4]);
    expect(endNoticeOf(pane).notice.hidden).toBe(true);
    expect(pane.slot.current).toEqual({ id: 2 });
  });

  it("shows the previous end notice again when Rust refuses the restart", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    spawns[0].onExit.onmessage(2);
    tauri.invoke.mockImplementation((command) =>
      command === "pty_spawn" ? Promise.reject(new Error("folder refused")) : Promise.resolve(),
    );
    await expect(pane.start("new")).rejects.toThrow("folder refused");
    const { notice, text } = endNoticeOf(pane);
    expect(notice.hidden).toBe(false);
    expect(text.textContent).toBe("Claude Code ended (code 2)");
  });

  it("shows no end notice when the first start is refused", async () => {
    tauri.invoke.mockImplementation((command) =>
      command === "pty_spawn" ? Promise.reject(new Error("folder refused")) : Promise.resolve(),
    );
    const pane = openPane(1, recorder().handlers);
    await expect(pane.start("new")).rejects.toThrow("folder refused");
    expect(endNoticeOf(pane).notice.hidden).toBe(true);
  });
});

describe("TabPane start notice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts hidden", () => {
    const pane = openPane(1, recorder().handlers);
    expect(startNoticeOf(pane).notice.hidden).toBe(true);
  });

  it("offers Resume and New session on a restored tab, and tells the page which one", () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    pane.showOffer("resume");
    const { notice, text, resume, newSession } = startNoticeOf(pane);
    expect(notice.hidden).toBe(false);
    expect(text.textContent).toBe("Resume the previous conversation, or start a new session.");
    expect(resume.hidden).toBe(false);
    expect(resume.textContent).toBe("Resume");
    expect(newSession.textContent).toBe("New session");
    resume.click();
    newSession.click();
    expect(events).toEqual(["resume", "restart"]);
  });

  it("resumes for its tab id and hides the notice", async () => {
    const pane = openPane(3, recorder().handlers);
    pane.showOffer("resume");
    expect(await pane.start("resume")).toBe(true);
    expect(spawns[0]).toMatchObject({ tabId: 3, mode: "resume" });
    expect(startNoticeOf(pane).notice.hidden).toBe(true);
  });

  it("offers only New session when the resume fails right away, instead of the end notice", async () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    pane.showOffer("resume");
    await pane.start("resume");
    spawns[0].onExit.onmessage(1);
    const { notice, text, resume } = startNoticeOf(pane);
    expect(notice.hidden).toBe(false);
    expect(text.textContent).toBe("The previous conversation could not be resumed.");
    expect(resume.hidden).toBe(true);
    expect(endNoticeOf(pane).notice.hidden).toBe(true);
    expect(events).toEqual(["exit 1"]);
  });

  it("shows the end notice when a resumed session ends after the failure window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const pane = openPane(1, recorder().handlers);
    await pane.start("resume");
    now.mockReturnValue(1_000 + 60_000);
    spawns[0].onExit.onmessage(1);
    expect(startNoticeOf(pane).notice.hidden).toBe(true);
    expect(endNoticeOf(pane).notice.hidden).toBe(false);
  });

  it("shows the end notice when a new session fails right away", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    spawns[0].onExit.onmessage(1);
    expect(startNoticeOf(pane).notice.hidden).toBe(true);
    expect(endNoticeOf(pane).notice.hidden).toBe(false);
  });

  it("shows the start notice again when Rust refuses the resume", async () => {
    tauri.invoke.mockImplementation((command) =>
      command === "pty_spawn" ? Promise.reject(new Error("no tab with id 1")) : Promise.resolve(),
    );
    const pane = openPane(1, recorder().handlers);
    pane.showOffer("resume");
    await expect(pane.start("resume")).rejects.toThrow("no tab with id 1");
    const { notice, resume } = startNoticeOf(pane);
    expect(notice.hidden).toBe(false);
    expect(resume.hidden).toBe(false);
    expect(endNoticeOf(pane).notice.hidden).toBe(true);
  });
});

describe("TabPane.close", () => {
  it("kills its session, disposes of the terminal and removes the container", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    await pane.close();
    expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    expect(pane.slot.current).toBeUndefined();
    expect(terminalOf(pane).disposed).toBe(true);
    expect(parent.children).toEqual([]);
  });

  it("leaves the other tabs' sessions running", async () => {
    const first = openPane(1, recorder().handlers);
    const second = openPane(2, recorder().handlers);
    await first.start("new");
    await second.start("new");
    await first.close();
    expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    expect(second.slot.current).toEqual({ id: 2 });
    expect(parent.children).toEqual([containerOf(second)]);
  });
});

describe("TabPane, hidden and shown", () => {
  it("does not refit while hidden, and sends the new size to its session once shown", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    pane.hide();
    const fitsWhileShown = fakes.state.fits;
    fakes.state.containerSize = { cols: 140, rows: 50 };
    for (const fire of observers) {
      fire();
    }
    expect(fakes.state.fits).toBe(fitsWhileShown);
    expect(calls("pty_resize")).toEqual([]);
    pane.show();
    await settle();
    expect(containerOf(pane).hidden).toBe(false);
    expect(calls("pty_resize")).toEqual([{ id: 1, cols: 140, rows: 50 }]);
  });

  it("resizes its session when its container changes size while shown", async () => {
    const pane = openPane(1, recorder().handlers);
    await pane.start("new");
    fakes.state.containerSize = { cols: 120, rows: 40 };
    for (const fire of observers) {
      fire();
    }
    await settle();
    expect(calls("pty_resize")).toEqual([{ id: 1, cols: 120, rows: 40 }]);
  });
});

describe("TabPane input", () => {
  it("sends what the user types to its own session", async () => {
    const first = openPane(1, recorder().handlers);
    const second = openPane(2, recorder().handlers);
    await first.start("new");
    await second.start("new");
    terminalOf(second).dataListener("ls");
    await settle();
    expect(calls("pty_write")).toEqual([{ id: 2, data: "ls" }]);
  });

  it("reports a failed write to the page", async () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    await pane.start("new");
    tauri.invoke.mockImplementation((command) =>
      command === "pty_write" ? Promise.reject(new Error("gone")) : Promise.resolve(),
    );
    terminalOf(pane).dataListener("x");
    await settle();
    expect(events).toEqual(["error Error: gone"]);
  });

  it("tells the page about the marker key once per press and keeps it from the terminal", () => {
    const { events, handlers } = recorder();
    const pane = openPane(1, handlers);
    const key = (type: string, repeat: boolean) => {
      const event = {
        type,
        repeat,
        code: "F9",
        key: "F9",
        keyCode: 120,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
      };
      return { event, passed: terminalOf(pane).keyHandler(event as unknown as KeyboardEvent) };
    };
    const press = key("keydown", false);
    const held = key("keydown", true);
    const release = key("keyup", false);
    expect([press.passed, held.passed, release.passed]).toEqual([false, false, false]);
    expect(press.event.preventDefault).toHaveBeenCalled();
    expect(events).toEqual(["mark"]);
  });
});

describe("ReplayPane", () => {
  it("opens a read-only terminal in its own container", () => {
    const pane = new ReplayPane(parent as unknown as HTMLElement, 3);
    expect(pane.tabId).toBe(3);
    expect(terminalOf(pane).options.disableStdin).toBe(true);
    expect(parent.children).toEqual([containerOf(pane)]);
  });

  it("disposes of its terminal and removes its container on close", () => {
    const pane = new ReplayPane(parent as unknown as HTMLElement, 3);
    pane.close();
    expect(terminalOf(pane).disposed).toBe(true);
    expect(parent.children).toEqual([]);
    expect(calls("pty_kill")).toEqual([]);
  });
});
