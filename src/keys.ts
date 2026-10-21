/** What the app does with a key event before xterm.js sees it. */
export type KeyDecision =
  /** xterm.js handles the key and sends it to the session. */
  | "terminal"
  /** The F9 marker shortcut: the app drops a marker, xterm.js never sees the key. */
  | "mark"
  /**
   * Ctrl+V: xterm.js must not send ^V, and the default action must not be prevented,
   * so the browser fires its native `paste` event, which xterm.js sends as a paste.
   */
  | "paste";

/** The fields of a keyboard event that the decision reads. */
export type KeyInput = Pick<
  KeyboardEvent,
  "type" | "code" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/**
 * Decides who handles a key event: the app shortcut, the browser paste, or xterm.js.
 * Applies to every event type (keydown, keypress, keyup).
 * @param event - the key event xterm.js is about to process
 * @returns the decision for this event
 */
export function decideKey(event: KeyInput): KeyDecision {
  const noModifier = !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (event.code === "F9" && noModifier) {
    return "mark";
  }
  const ctrlOnly = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (ctrlOnly && event.key.toLowerCase() === "v") {
    return "paste";
  }
  return "terminal";
}
