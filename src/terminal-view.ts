import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

/** How xterm.js draws the screen. */
export type Renderer = "dom" | "webgl";

/** Which Unicode table xterm.js uses to measure character widths. */
export type UnicodeVersion = "6" | "11";

/** Tells whether a string names a {@link Renderer}. */
export function isRenderer(value: string): value is Renderer {
  return value === "dom" || value === "webgl";
}

/** Tells whether a string names a {@link UnicodeVersion}. */
export function isUnicodeVersion(value: string): value is UnicodeVersion {
  return value === "6" || value === "11";
}

/**
 * One xterm.js terminal filling its container. It refits itself whenever the
 * container changes size, and its renderer and width table can be switched live.
 */
export class TerminalView {
  readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private webglAddon: WebglAddon | undefined;

  /** Opens a terminal in `container`, with the DOM renderer and the Unicode 6 table. */
  constructor(container: HTMLElement) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 10_000,
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.open(container);
    new ResizeObserver(() => {
      this.fit();
    }).observe(container);
  }

  /** Resizes the terminal grid to fill its container. */
  fit(): void {
    this.fitAddon.fit();
  }

  /**
   * Switches the renderer and returns the one now in use: asking for WebGL
   * returns `"dom"` when the webview cannot create a WebGL context. A WebGL
   * context lost later falls back to the DOM renderer and calls `onFallback`.
   */
  setRenderer(renderer: Renderer, onFallback: () => void): Renderer {
    if (renderer === "dom") {
      this.webglAddon?.dispose();
      this.webglAddon = undefined;
      return "dom";
    }
    if (this.webglAddon) {
      return "webgl";
    }
    const addon = new WebglAddon();
    try {
      this.terminal.loadAddon(addon);
    } catch {
      addon.dispose();
      return "dom";
    }
    addon.onContextLoss(() => {
      addon.dispose();
      this.webglAddon = undefined;
      onFallback();
    });
    this.webglAddon = addon;
    return "webgl";
  }

  /** Switches the width table and redraws the whole screen. */
  setUnicodeVersion(version: UnicodeVersion): void {
    this.terminal.unicode.activeVersion = version;
    this.terminal.refresh(0, this.terminal.rows - 1);
  }
}
