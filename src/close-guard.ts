/** How long after a tab closes, in milliseconds, a click on a close button is ignored. */
export const CLOSE_GUARD_DELAY_MS = 500;

/**
 * Decides whether a click on a tab's close button closes the tab. A click
 * that comes less than `delayMs` after the last accepted one is ignored, so a
 * double click closes one tab, not the one that slides under the cursor.
 */
export class CloseGuard {
  private lastClose: number | undefined;

  /** Ignores close clicks for `delayMs` milliseconds after each accepted one. */
  constructor(private readonly delayMs: number = CLOSE_GUARD_DELAY_MS) {}

  /**
   * Returns `true` when a close click at `now`, in milliseconds, closes its
   * tab, and records it; returns `false` when it comes too soon after the last one.
   */
  accept(now: number): boolean {
    if (this.lastClose !== undefined && now - this.lastClose < this.delayMs) {
      return false;
    }
    this.lastClose = now;
    return true;
  }
}
