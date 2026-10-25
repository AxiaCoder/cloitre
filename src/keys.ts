/** What the app does with a key event before xterm.js sees it. */
export type KeyDecision =
  /** xterm.js handles the key and sends it to the session. */
  | "terminal"
  /** The F9 marker shortcut: the app drops a marker, xterm.js never sees the key. */
  | "mark"
  /**
   * Ctrl+V or Ctrl+Shift+V: xterm.js must not send ^V, and the default action must not be
   * prevented, so the browser fires its native `paste` event, which xterm.js sends as a paste.
   */
  | "paste"
  /**
   * Ctrl+C or Ctrl+Shift+C with a selection in the terminal: xterm.js must not send ^C, and the
   * default action must not be prevented, so the browser fires its native `copy` event, which
   * xterm.js fills with the selection.
   */
  | "copy";

/** The virtual key code of the V key, the same on every keyboard layout. */
const VIRTUAL_KEY_V = 86;

/** The virtual key code of the C key, the same on every keyboard layout. */
const VIRTUAL_KEY_C = 67;

/** The fields of a keyboard event that the decision reads. */
export type KeyInput = Pick<
  KeyboardEvent,
  "type" | "code" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
> & {
  /** The virtual key code, which does not change with the keyboard layout. */
  readonly keyCode: number;
};

/**
 * Decides who handles a key event: the app shortcut, the browser paste or copy, or xterm.js.
 * Applies to every event type (keydown, keypress, keyup).
 * The paste and copy shortcuts are matched on the virtual key code, so they work on every
 * keyboard layout. Without a selection, Ctrl+C goes to the session as an interrupt.
 * @param event - the key event xterm.js is about to process
 * @param hasSelection - whether the terminal has a selection of its own
 * @returns the decision for this event
 */
export function decideKey(event: KeyInput, hasSelection: boolean): KeyDecision {
  const noModifier = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (event.code === "F9" && noModifier) {
    return "mark";
  }
  const ctrlWithoutAltOrMeta = event.ctrlKey && !event.altKey && !event.metaKey;
  if (ctrlWithoutAltOrMeta && event.keyCode === VIRTUAL_KEY_V) {
    return "paste";
  }
  if (ctrlWithoutAltOrMeta && event.keyCode === VIRTUAL_KEY_C && hasSelection) {
    return "copy";
  }
  return "terminal";
}

/** The virtual key code of the D key, the same on every keyboard layout. */
const VIRTUAL_KEY_D = 68;

/**
 * Returns whether `event` is a keydown of Ctrl+Shift+D, which shows or hides
 * the developer tools. Matched on the virtual key code, so it works on every
 * keyboard layout. A held key's repeats match too: the caller keeps them from
 * the terminal and toggles on the first one only.
 * @param event - the key event the window is about to dispatch
 */
export function isToolsShortcut(event: KeyInput): boolean {
  return (
    event.type === "keydown" &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.keyCode === VIRTUAL_KEY_D
  );
}
