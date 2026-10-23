import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";

import { texts } from "./strings";

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

/** The terminal font size, in CSS pixels. */
const TERMINAL_FONT_SIZE = 14;

/** Reads one CSS custom property, such as `--term-bg`; `""` when it is not set. */
export type TokenReader = (name: string) => string;

/** The font and colors of a terminal, as xterm.js takes them. Unset ones keep the xterm.js default. */
export interface TerminalAppearance {
  fontFamily?: string;
  theme: ITheme;
}

/** Which CSS custom property gives each color of the terminal theme. */
const THEME_TOKENS: Readonly<Record<string, keyof ITheme>> = {
  "--term-bg": "background",
  "--term-fg": "foreground",
  "--term-cursor": "cursor",
  "--term-cursor-ink": "cursorAccent",
  "--term-selection": "selectionBackground",
  "--term-scrollbar": "scrollbarSliderBackground",
  "--term-scrollbar-hover": "scrollbarSliderHoverBackground",
  "--term-scrollbar-active": "scrollbarSliderActiveBackground",
};

/**
 * Builds the terminal appearance from the CSS tokens `read` returns: the font
 * from `--font-mono`, the colors from the `--term-*` tokens. A token that reads
 * empty is left out.
 */
export function terminalAppearance(read: TokenReader): TerminalAppearance {
  const theme: Record<string, string> = {};
  for (const [token, key] of Object.entries(THEME_TOKENS)) {
    const value = read(token).trim();
    if (value !== "") {
      theme[key] = value;
    }
  }
  const fontFamily = read("--font-mono").trim();
  return fontFamily === "" ? { theme } : { fontFamily, theme };
}

/**
 * The terminal appearance from the tokens on the page's root element. Without
 * a page to read, as under Node, every token reads empty.
 */
export function readTerminalAppearance(): TerminalAppearance {
  if (typeof getComputedStyle !== "function") {
    return terminalAppearance(() => "");
  }
  const style = getComputedStyle(document.documentElement);
  return terminalAppearance((name) => style.getPropertyValue(name));
}

/**
 * Resolves once the regular and bold faces of the terminal font are loaded, so
 * a terminal opened afterwards measures its cells on the right glyphs. Never
 * rejects: a font that fails to load leaves the fallback in place.
 */
export async function loadTerminalFonts(): Promise<void> {
  const { fontFamily } = readTerminalAppearance();
  if (fontFamily === undefined) {
    return;
  }
  try {
    await Promise.all([
      document.fonts.load(`${String(TERMINAL_FONT_SIZE)}px ${fontFamily}`),
      document.fonts.load(`600 ${String(TERMINAL_FONT_SIZE)}px ${fontFamily}`),
    ]);
  } catch {
    return;
  }
}

/**
 * One xterm.js terminal filling its container. It refits itself whenever the
 * container changes size while visible, and its renderer and width table can
 * be switched live.
 */
export class TerminalView {
  readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly resizeObserver: ResizeObserver;
  private webglAddon: WebglAddon | undefined;
  private visible = true;

  /**
   * Opens a terminal in `container`, drawn by the DOM renderer until
   * {@link TerminalView.setRenderer} switches it, with the Unicode 15 grapheme table.
   * Its font and colors come from `appearance`, by default the page's CSS tokens.
   */
  constructor(container: HTMLElement, appearance: TerminalAppearance = readTerminalAppearance()) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      ...appearance,
      fontSize: TERMINAL_FONT_SIZE,
      fontWeightBold: "600",
      scrollback: 10_000,
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new UnicodeGraphemesAddon());
    this.terminal.unicode.activeVersion = "15-graphemes";
    this.terminal.open(container);
    this.resizeObserver = new ResizeObserver(() => {
      if (this.autoFit) {
        this.fit();
      }
    });
    this.resizeObserver.observe(container);
  }

  /**
   * Whether the grid follows the size of its container. Turned off during a
   * replay, so the recorded sizes stay in place.
   */
  autoFit = true;

  /**
   * Resizes the terminal grid to fill its container. Does nothing while the
   * view is hidden: the grid keeps its last size until shown again.
   */
  fit(): void {
    if (this.visible) {
      this.fitAddon.fit();
    }
  }

  /**
   * Tells the view whether its container is shown. Hiding it drops WebGL for
   * the DOM renderer, freeing its context; the caller picks the renderer again
   * once shown. Showing it refits the grid, unless auto fit is off.
   */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) {
      this.setRenderer("dom", () => undefined);
    } else if (this.autoFit) {
      this.fit();
    }
  }

  /**
   * Stops following the container, frees the WebGL context, if any, and
   * disposes of the terminal. The view is unusable afterwards.
   */
  dispose(): void {
    this.resizeObserver.disconnect();
    this.setRenderer("dom", () => undefined);
    this.terminal.dispose();
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

/** The control that shows which renderer is in use, such as a `<select>`. */
export interface RendererPicker {
  value: string;
}

/**
 * Switches `view` to `wanted` and keeps `picker` on the renderer actually in
 * use. When WebGL cannot start, or its context is lost later, the view falls
 * back to the DOM renderer, `picker` moves to `"dom"` and `showStatus` says why.
 */
export function showRenderer(
  view: TerminalView,
  wanted: Renderer,
  picker: RendererPicker,
  showStatus: (message: string) => void,
): void {
  picker.value = view.setRenderer(wanted, () => {
    picker.value = "dom";
    showStatus(texts.webglLost);
  });
  if (picker.value !== wanted) {
    showStatus(texts.webglUnavailable);
  }
}
