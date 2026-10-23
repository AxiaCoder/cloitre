/** What the warning bar can show: the project list's load warning and the last failed action's error. */
export interface WarningState {
  /** The warning Rust gave with the last project list, or `null` when it gave none. */
  readonly loadWarning: string | null;
  /** Whether the user closed the load warning; it stays closed until the app restarts. */
  readonly loadClosed: boolean;
  /** The error of the last failed action, kept until the user closes it. */
  readonly actionError: string | undefined;
}

/** The warning bar of a page that has shown nothing yet. */
export const NO_WARNING: WarningState = { loadWarning: null, loadClosed: false, actionError: undefined };

/**
 * Returns the text the warning bar shows for `state`, or `undefined` when it is hidden:
 * the action error first, else the load warning unless the user closed it.
 */
export function warningText(state: WarningState): string | undefined {
  if (state.actionError !== undefined) {
    return state.actionError;
  }
  return state.loadWarning !== null && !state.loadClosed ? state.loadWarning : undefined;
}

/**
 * Returns `state` after the user closed the bar: the action error goes when it
 * was the one shown, else the load warning closes.
 */
export function closeWarning(state: WarningState): WarningState {
  if (state.actionError !== undefined) {
    return { ...state, actionError: undefined };
  }
  return { ...state, loadClosed: true };
}
