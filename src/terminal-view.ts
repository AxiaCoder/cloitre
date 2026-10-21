import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

/** How xterm.js draws the screen. */
export type Renderer = "dom" | "webgl";

/**
 * Which Unicode table xterm.js uses to measure character widths.
 * `"15-graphemes"` also measures a grapheme cluster (emoji with VS16, ZWJ sequence) as one unit.
 */
export type UnicodeVersion = "6" | "15" | "15-graphemes";

/** Tells whether a string names a {@link Renderer}. */
export function isRenderer(value: string): value is Renderer {
  return value === "dom" || value === "webgl";
}

/** Tells whether a string names a {@link UnicodeVersion}. */
export function isUnicodeVersion(value: string): value is UnicodeVersion {
  return value === "6" || value === "15" || value === "15-graphemes";
}

/**
 * One xterm.js terminal filling its container. It refits itself whenever the
 * container changes size, and its renderer and width table can be switched live.
 */
export class TerminalView {
  readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private webglAddon: WebglAddon | undefined;

  /** Opens a terminal in `container`, with the DOM renderer and the Unicode 15 grapheme table. */
  constructor(container: HTMLElement) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 10_000,
      theme: {
        background: "#000000",
        scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
        scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.25)",
        scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.35)",
      },
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
    this.terminal.unicode.activeVersion = "15-graphemes";
    this.terminal.open(container);
    new ResizeObserver(() => {
      if (this.autoFit) {
        this.fit();
      }
    }).observe(container);
  }

  /**
   * Whether the grid follows the size of its container. Turned off during a
   * replay, so the recorded sizes stay in place.
   */
  autoFit = true;

  /** Resizes the terminal grid to fill its container. */
  fit(): void {
    this.fitAddon.fit();
  }

  /**
   * Clears the screen and its scrollback, then makes the grid follow its
   * container again and fits it at once.
   */
  clearAndFit(): void {
    this.terminal.reset();
    this.autoFit = true;
    this.fit();
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
