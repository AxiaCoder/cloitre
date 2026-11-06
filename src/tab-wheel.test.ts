import { describe, expect, it } from "vitest";
import { LINE_SCROLL_PX, tabBarScroll } from "./tab-wheel";

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;
const PAGE_WIDTH = 300;

describe("tabBarScroll", () => {
  it("turns a vertical pixel delta into the same sideways scroll", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 120, deltaMode: PIXEL }, PAGE_WIDTH)).toBe(120);
    expect(tabBarScroll({ deltaX: 0, deltaY: -53.5, deltaMode: PIXEL }, PAGE_WIDTH)).toBe(-53.5);
  });

  it("scrolls a fixed number of pixels per wheel line", () => {
    expect(LINE_SCROLL_PX).toBe(40);
    expect(tabBarScroll({ deltaX: 0, deltaY: 3, deltaMode: LINE }, PAGE_WIDTH)).toBe(120);
    expect(tabBarScroll({ deltaX: 0, deltaY: -1, deltaMode: LINE }, PAGE_WIDTH)).toBe(-40);
  });

  it("scrolls one visible width of the tab list per wheel page", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 1, deltaMode: PAGE }, PAGE_WIDTH)).toBe(300);
    expect(tabBarScroll({ deltaX: 0, deltaY: -2, deltaMode: PAGE }, PAGE_WIDTH)).toBe(-600);
  });

  it("ignores the page width for pixel and line deltas", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 120, deltaMode: PIXEL }, 999)).toBe(120);
    expect(tabBarScroll({ deltaX: 0, deltaY: 3, deltaMode: LINE }, 999)).toBe(120);
  });

  it("leaves an event without vertical delta to the browser", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 0, deltaMode: PIXEL }, PAGE_WIDTH)).toBeUndefined();
    expect(tabBarScroll({ deltaX: 30, deltaY: 0, deltaMode: PIXEL }, PAGE_WIDTH)).toBeUndefined();
  });

  it("leaves a mostly horizontal swipe to the browser", () => {
    expect(tabBarScroll({ deltaX: 50, deltaY: 10, deltaMode: PIXEL }, PAGE_WIDTH)).toBeUndefined();
    expect(tabBarScroll({ deltaX: -50, deltaY: -49, deltaMode: LINE }, PAGE_WIDTH)).toBeUndefined();
  });

  it("takes over a diagonal turn as vertical when both deltas are equal", () => {
    expect(tabBarScroll({ deltaX: 20, deltaY: 20, deltaMode: PIXEL }, PAGE_WIDTH)).toBe(20);
    expect(tabBarScroll({ deltaX: -2, deltaY: 2, deltaMode: LINE }, PAGE_WIDTH)).toBe(80);
  });
});
