import { describe, expect, it } from "vitest";
import { COLOR_CHOICES, GRID_COLUMNS, currentSymbol, gridMove, isMenuKey, symbolChoices, tabWrap } from "./project-menu";
import { FALLBACK_ICON, MARKER_COLORS, MARKER_ICONS } from "./project-marker";
import { messages } from "./strings";

describe("COLOR_CHOICES", () => {
  it("starts with no color, then every palette color in order", () => {
    expect(COLOR_CHOICES).toEqual([null, ...MARKER_COLORS]);
  });
});

describe("symbolChoices", () => {
  it("starts with the initials, then every icon in order", () => {
    expect(symbolChoices("web site")).toEqual([null, ...MARKER_ICONS]);
  });

  it("has no initials for a name without a letter", () => {
    expect(symbolChoices("2048")).toEqual(MARKER_ICONS);
  });
});

describe("currentSymbol", () => {
  it("is the icon when there is one, else the initials", () => {
    expect(currentSymbol("globe", "web site")).toBe("globe");
    expect(currentSymbol(null, "web site")).toBeNull();
  });

  it("is the fallback icon the marker shows for a name without a letter", () => {
    expect(currentSymbol(null, "2048")).toBe(FALLBACK_ICON);
    expect(currentSymbol("star", "2048")).toBe("star");
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

describe("tabWrap", () => {
  it("wraps Tab from the last tab stop to the first", () => {
    expect(tabWrap(4, 5, false)).toBe(0);
  });

  it("wraps Shift+Tab from the first tab stop to the last", () => {
    expect(tabWrap(0, 5, true)).toBe(4);
  });

  it("brings a focus from outside the loop to the first stop on Tab and the last on Shift+Tab", () => {
    expect(tabWrap(-1, 5, false)).toBe(0);
    expect(tabWrap(-1, 5, true)).toBe(4);
  });

  it("leaves a move inside the loop to the browser", () => {
    expect(tabWrap(2, 5, false)).toBeUndefined();
    expect(tabWrap(2, 5, true)).toBeUndefined();
    expect(tabWrap(0, 5, false)).toBeUndefined();
    expect(tabWrap(4, 5, true)).toBeUndefined();
  });

  it("keeps the focus on the only tab stop of a one-stop loop", () => {
    expect(tabWrap(0, 1, false)).toBe(0);
    expect(tabWrap(0, 1, true)).toBe(0);
    expect(tabWrap(-1, 1, false)).toBe(0);
    expect(tabWrap(-1, 1, true)).toBe(0);
  });

  it("does nothing on an empty loop", () => {
    expect(tabWrap(-1, 0, false)).toBeUndefined();
    expect(tabWrap(-1, 0, true)).toBeUndefined();
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

});

describe("the marker choice names", () => {
  it("name a color in words, or no color", () => {
    expect(messages.markerColorName("teal")).toBe("Teal");
    expect(messages.markerColorName(null)).toBe("No color");
  });

  it("name a symbol in words, or the initials", () => {
    expect(messages.markerSymbolName("globe")).toBe("Globe");
    expect(messages.markerSymbolName(null)).toBe("Initials");
  });
});
