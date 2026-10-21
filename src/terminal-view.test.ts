import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => {
  /** Stand-in for an xterm.js addon: records its disposal. */
  class FakeAddon {
    disposed = 0;
    /** Counts one disposal. */
    dispose(): void {
      this.disposed += 1;
    }
  }

  /** Stand-in for the WebGL addon: the test fires the context loss by hand. */
  class FakeWebglAddon extends FakeAddon {
    loseContext: (() => void) | undefined;
    /** Registers the addon so the test can reach it. */
    constructor() {
      super();
      state.webglAddons.push(this);
    }
    /** Keeps the listener the test fires as a context loss. */
    onContextLoss(listener: () => void): void {
      this.loseContext = listener;
    }
  }

  /** Stand-in for the fit addon: counts fits. */
  class FakeFitAddon extends FakeAddon {
    fits = 0;
    /** Counts one fit. */
    fit(): void {
      this.fits += 1;
    }
  }

  /** Stand-in for the xterm.js terminal: records what is loaded and refreshed. */
  class FakeTerminal {
    rows = 24;
    unicode = { activeVersion: "6" };
    loaded: FakeAddon[] = [];
    refreshed: [number, number][] = [];
    /** Registers the terminal so the test can reach it. */
    constructor() {
      state.terminals.push(this);
    }
    /** Loads `addon`, or throws like xterm.js when WebGL is set to fail. */
    loadAddon(addon: FakeAddon): void {
      if (addon instanceof FakeWebglAddon && state.webglFails) {
        throw new Error("WebGL2 not supported");
      }
      this.loaded.push(addon);
    }
    /** Does nothing: there is no screen to attach to. */
    open(): void {
      return undefined;
    }
    /** Records the redrawn row range. */
    refresh(start: number, end: number): void {
      this.refreshed.push([start, end]);
    }
  }

  const state = {
    webglFails: false,
    webglAddons: [] as FakeWebglAddon[],
    terminals: [] as FakeTerminal[],
  };
  return { FakeAddon, FakeFitAddon, FakeTerminal, FakeWebglAddon, state };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xterm.FakeFitAddon }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: xterm.FakeAddon }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: xterm.FakeWebglAddon }));

import { TerminalView, isRenderer, isUnicodeVersion } from "./terminal-view";

let observers: { callback: () => void; observed: unknown[] }[];

beforeEach(() => {
  xterm.state.webglFails = false;
  xterm.state.webglAddons = [];
  xterm.state.terminals = [];
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observed: unknown[] = [];
      /** Registers the observer so the test can fire it. */
      constructor(readonly callback: () => void) {
        observers.push(this);
      }
      /** Records the observed element. */
      observe(target: unknown): void {
        this.observed.push(target);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Opens a view on a dummy container and returns it with its fake terminal. */
function openView() {
  const container = {} as HTMLElement;
  const view = new TerminalView(container);
  const [terminal] = xterm.state.terminals;
  if (xterm.state.terminals.length !== 1) {
    throw new Error("expected exactly one terminal");
  }
  return { view, terminal, container };
}

/** The fit addon loaded in `terminal`. */
function fitAddonOf(terminal: InstanceType<typeof xterm.FakeTerminal>) {
  const addon = terminal.loaded.find((loaded) => loaded instanceof xterm.FakeFitAddon);
  if (!addon) {
    throw new Error("no fit addon loaded");
  }
  return addon;
}

describe("isRenderer and isUnicodeVersion", () => {
  it("accept only the known names", () => {
    expect(["dom", "webgl", "canvas", "", "DOM"].map(isRenderer)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(["6", "11", "15", "", " 6"].map(isUnicodeVersion)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("TerminalView resize", () => {
  it("refits the terminal each time its container changes size", () => {
    const { terminal, container } = openView();
    const fit = fitAddonOf(terminal);
    expect(observers).toHaveLength(1);
    expect(observers[0]?.observed).toEqual([container]);
    observers[0]?.callback();
    observers[0]?.callback();
    expect(fit.fits).toBe(2);
  });

  it("leaves the grid alone while auto fit is off", () => {
    const { view, terminal } = openView();
    const fit = fitAddonOf(terminal);
    view.autoFit = false;
    observers[0]?.callback();
    expect(fit.fits).toBe(0);
    view.autoFit = true;
    observers[0]?.callback();
    expect(fit.fits).toBe(1);
  });
});

describe("TerminalView.setRenderer", () => {
  it("starts on the DOM renderer and loads WebGL on demand", () => {
    const { view, terminal } = openView();
    expect(xterm.state.webglAddons).toHaveLength(0);
    expect(view.setRenderer("webgl", vi.fn())).toBe("webgl");
    expect(terminal.loaded).toContain(xterm.state.webglAddons[0]);
  });

  it("keeps a single WebGL addon when WebGL is asked twice", () => {
    const { view } = openView();
    view.setRenderer("webgl", vi.fn());
    expect(view.setRenderer("webgl", vi.fn())).toBe("webgl");
    expect(xterm.state.webglAddons).toHaveLength(1);
  });

  it("disposes the WebGL addon when going back to DOM", () => {
    const { view } = openView();
    view.setRenderer("webgl", vi.fn());
    expect(view.setRenderer("dom", vi.fn())).toBe("dom");
    expect(xterm.state.webglAddons[0]?.disposed).toBe(1);
    view.setRenderer("webgl", vi.fn());
    expect(xterm.state.webglAddons).toHaveLength(2);
  });

  it("returns dom and disposes the addon when WebGL cannot start", () => {
    const { view } = openView();
    xterm.state.webglFails = true;
    const onFallback = vi.fn();
    expect(view.setRenderer("webgl", onFallback)).toBe("dom");
    expect(xterm.state.webglAddons[0]?.disposed).toBe(1);
    expect(onFallback).not.toHaveBeenCalled();
    xterm.state.webglFails = false;
    expect(view.setRenderer("webgl", vi.fn())).toBe("webgl");
  });

  it("falls back to DOM and calls onFallback when the WebGL context is lost", () => {
    const { view } = openView();
    const onFallback = vi.fn();
    view.setRenderer("webgl", onFallback);
    const addon = xterm.state.webglAddons[0];
    addon.loseContext?.();
    expect(onFallback).toHaveBeenCalledOnce();
    expect(addon.disposed).toBe(1);
    expect(view.setRenderer("webgl", vi.fn())).toBe("webgl");
    expect(xterm.state.webglAddons).toHaveLength(2);
  });
});

describe("TerminalView.setUnicodeVersion", () => {
  it("switches the width table and redraws every row", () => {
    const { view, terminal } = openView();
    view.setUnicodeVersion("11");
    expect(terminal.unicode.activeVersion).toBe("11");
    expect(terminal.refreshed).toEqual([[0, 23]]);
  });
});
