import { describe, expect, it } from "vitest";
import { GRID_COLUMNS, MARKER_MODES, gridMove, isMenuKey, markerMode, switchMove } from "./project-menu";
import { MARKER_COLORS, MARKER_ICONS } from "./project-marker";
import { messages } from "./strings";

describe("markerMode", () => {
  it("is color without an icon and icon with one", () => {
    expect(markerMode(null)).toBe("color");
    expect(markerMode("star")).toBe("icon");
  });
});

describe("MARKER_MODES", () => {
  it("lists color before icon, the order the switch keys move in", () => {
    expect(MARKER_MODES).toEqual(["color", "icon"]);
  });
});

describe("switchMove", () => {
  it("goes to color on left, up and Home, to icon on right, down and End", () => {
    expect(["ArrowLeft", "ArrowUp", "Home"].map(switchMove)).toEqual(["color", "color", "color"]);
    expect(["ArrowRight", "ArrowDown", "End"].map(switchMove)).toEqual(["icon", "icon", "icon"]);
  });

  it("ignores other keys", () => {
    expect(switchMove("Enter")).toBeUndefined();
    expect(switchMove("a")).toBeUndefined();
  });
});

describe("gridMove", () => {
  const colors = MARKER_COLORS.length;

  it("moves left and right, wrapping at the row ends and at the grid ends", () => {
    expect(gridMove(0, colors, GRID_COLUMNS, "ArrowRight")).toBe(1);
    expect(gridMove(5, colors, GRID_COLUMNS, "ArrowRight")).toBe(6);
    expect(gridMove(6, colors, GRID_COLUMNS, "ArrowLeft")).toBe(5);
    expect(gridMove(colors - 1, colors, GRID_COLUMNS, "ArrowRight")).toBe(0);
    expect(gridMove(0, colors, GRID_COLUMNS, "ArrowLeft")).toBe(colors - 1);
  });

  it("moves up and down in the column, wrapping to its other end", () => {
    expect(gridMove(1, 15, 6, "ArrowDown")).toBe(7);
    expect(gridMove(7, 15, 6, "ArrowUp")).toBe(1);
    expect(gridMove(13, 15, 6, "ArrowDown")).toBe(1);
    expect(gridMove(1, 15, 6, "ArrowUp")).toBe(13);
  });

  it("skips the missing cells of a short last row", () => {
    expect(gridMove(4, 15, 6, "ArrowUp")).toBe(10);
    expect(gridMove(10, 15, 6, "ArrowDown")).toBe(4);
    expect(gridMove(5, 11, 6, "ArrowDown")).toBe(5);
    expect(gridMove(5, 11, 6, "ArrowUp")).toBe(5);
    expect(MARKER_ICONS).toHaveLength(11);
  });

  it("wraps up from the first row to the same column of a full last row", () => {
    expect(gridMove(2, 12, 6, "ArrowUp")).toBe(8);
    expect(gridMove(8, 12, 6, "ArrowDown")).toBe(2);
  });

  it("stays in place up and down in a grid of a single row", () => {
    expect(gridMove(2, 4, 6, "ArrowUp")).toBe(2);
    expect(gridMove(2, 4, 6, "ArrowDown")).toBe(2);
    expect(gridMove(3, 4, 6, "ArrowRight")).toBe(0);
  });

  it("stays on the only choice of a one-choice grid", () => {
    expect(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].map((key) => gridMove(0, 1, 6, key))).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it("goes to the first and last choice on Home and End", () => {
    expect(gridMove(7, 15, 6, "Home")).toBe(0);
    expect(gridMove(7, 15, 6, "End")).toBe(14);
  });

  it("ignores other keys and empty grids", () => {
    expect(gridMove(3, 15, 6, "Enter")).toBeUndefined();
    expect(gridMove(0, 0, 6, "ArrowRight")).toBeUndefined();
  });
});

describe("isMenuKey", () => {
  const key = (name: string, modifiers: Partial<Record<"shiftKey" | "ctrlKey" | "altKey" | "metaKey", boolean>> = {}) => ({
    key: name,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers,
  });

  it("accepts Shift+F10 and the menu key", () => {
    expect(isMenuKey(key("F10", { shiftKey: true }))).toBe(true);
    expect(isMenuKey(key("ContextMenu"))).toBe(true);
  });

  it("refuses F10 alone or with another modifier, and other keys", () => {
    expect(isMenuKey(key("F10"))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isMenuKey(key("Enter", { shiftKey: true }))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, altKey: true }))).toBe(false);
    expect(isMenuKey(key("F10", { shiftKey: true, metaKey: true }))).toBe(false);
  });
});

describe("the removal texts", () => {
  it("say what happens to no tab, one tab or several", () => {
    expect(messages.removeTabs(0)).toBe("No tab is open for it.");
    expect(messages.removeTabs(1)).toBe("Its tab will close and its session will stop.");
    expect(messages.removeTabs(3)).toBe("Its 3 tabs will close and their sessions will stop.");
  });

  it("quote Rust's refusal once, without a doubled period", () => {
    const expected = "The project could not be removed: the app data could not be saved. Nothing has changed. Try again.";
    expect(messages.removeFailed("the app data could not be saved")).toBe(expected);
    expect(messages.removeFailed("the app data could not be saved.")).toBe(expected);
  });

  it("name the mode the project shows when the switch shows the other", () => {
    expect(messages.markerHint("color")).toBe("Showing a color now. Pick an icon to replace it.");
    expect(messages.markerHint("icon")).toBe("Showing an icon now. Pick a color to replace it.");
  });
});
