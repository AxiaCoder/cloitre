import { describe, expect, it } from "vitest";
import { LINE_SCROLL_PX, tabBarScroll } from "./tab-wheel";

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe("tabBarScroll", () => {
  it("turns a vertical pixel delta into the same sideways scroll", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 120, deltaMode: PIXEL })).toBe(120);
    expect(tabBarScroll({ deltaX: 0, deltaY: -53.5, deltaMode: PIXEL })).toBe(-53.5);
  });

  it("scrolls a fixed number of pixels per wheel line", () => {
    expect(LINE_SCROLL_PX).toBe(40);
    expect(tabBarScroll({ deltaX: 0, deltaY: 3, deltaMode: LINE })).toBe(120);
    expect(tabBarScroll({ deltaX: 0, deltaY: -1, deltaMode: LINE })).toBe(-40);
  });

  it("counts a page delta as pixels", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 1, deltaMode: PAGE })).toBe(1);
  });

  it("leaves an event without vertical delta to the browser", () => {
    expect(tabBarScroll({ deltaX: 0, deltaY: 0, deltaMode: PIXEL })).toBeUndefined();
    expect(tabBarScroll({ deltaX: 30, deltaY: 0, deltaMode: PIXEL })).toBeUndefined();
  });

  it("leaves a mostly horizontal swipe to the browser", () => {
    expect(tabBarScroll({ deltaX: 50, deltaY: 10, deltaMode: PIXEL })).toBeUndefined();
    expect(tabBarScroll({ deltaX: -50, deltaY: -49, deltaMode: LINE })).toBeUndefined();
  });

  it("takes over a diagonal turn as vertical when both deltas are equal", () => {
    expect(tabBarScroll({ deltaX: 20, deltaY: 20, deltaMode: PIXEL })).toBe(20);
    expect(tabBarScroll({ deltaX: -2, deltaY: 2, deltaMode: LINE })).toBe(80);
  });
});
