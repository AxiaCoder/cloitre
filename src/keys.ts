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
  | "paste";

/** The virtual key code of the V key, the same on every keyboard layout. */
const VIRTUAL_KEY_V = 86;

/** The fields of a keyboard event that the decision reads. */
export type KeyInput = Pick<
  KeyboardEvent,
  "type" | "code" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
> & {
  /** The virtual key code, which does not change with the keyboard layout. */
  readonly keyCode: number;
};

/**
 * Decides who handles a key event: the app shortcut, the browser paste, or xterm.js.
 * Applies to every event type (keydown, keypress, keyup).
 * The paste shortcut is matched on the virtual key code, so it works on every keyboard layout.
 * @param event - the key event xterm.js is about to process
 * @returns the decision for this event
 */
export function decideKey(event: KeyInput): KeyDecision {
  const noModifier = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (event.code === "F9" && noModifier) {
    return "mark";
  }
  const ctrlWithoutAltOrMeta = event.ctrlKey && !event.altKey && !event.metaKey;
  if (ctrlWithoutAltOrMeta && event.keyCode === VIRTUAL_KEY_V) {
    return "paste";
  }
  return "terminal";
}
