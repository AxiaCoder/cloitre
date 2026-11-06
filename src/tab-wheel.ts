/** The fields of a wheel event that decide how far the tab bar scrolls. */
export interface WheelDelta {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/** `WheelEvent.DOM_DELTA_LINE`: the deltas count lines, not pixels. */
const DOM_DELTA_LINE = 1;

/** `WheelEvent.DOM_DELTA_PAGE`: the deltas count pages, not pixels. */
const DOM_DELTA_PAGE = 2;

/** The pixels one wheel line scrolls the tab bar. */
export const LINE_SCROLL_PX = 40;

/**
 * Returns how many pixels a vertical wheel turn scrolls the tab bar sideways, positive to the right.
 * Returns `undefined` when the event is not a vertical turn — no vertical delta, or a mostly horizontal
 * one — and must be left to the browser. A delta in lines counts `LINE_SCROLL_PX` per line, a delta in
 * pages counts `pageWidth` per page; any other mode counts as pixels.
 * `pageWidth` is in pixels: one page is the visible width of the tab list.
 */
export function tabBarScroll(wheel: WheelDelta, pageWidth: number): number | undefined {
  if (wheel.deltaY === 0 || Math.abs(wheel.deltaX) > Math.abs(wheel.deltaY)) return undefined;
  if (wheel.deltaMode === DOM_DELTA_LINE) return wheel.deltaY * LINE_SCROLL_PX;
  if (wheel.deltaMode === DOM_DELTA_PAGE) return wheel.deltaY * pageWidth;
  return wheel.deltaY;
}
