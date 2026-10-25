import { describe, expect, it } from "vitest";

import { decideKey, isToolsShortcut, type KeyInput } from "./keys";

/** Builds a key event with no modifier, overridden by `fields`. */
function key(fields: Partial<KeyInput>): KeyInput {
  return {
    type: "keydown",
    code: "",
    key: "",
    keyCode: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...fields,
  };
}

describe("decideKey", () => {
  it("leaves Ctrl+V to the browser paste instead of sending ^V", () => {
    expect(decideKey(key({ code: "KeyV", key: "v", keyCode: 86, ctrlKey: true }), false)).toBe("paste");
  });

  it("leaves Ctrl+V to the browser paste on keyup too", () => {
    expect(
      decideKey(key({ type: "keyup", code: "KeyV", key: "v", keyCode: 86, ctrlKey: true }), false),
    ).toBe("paste");
  });

  it("leaves Ctrl+V to the browser paste whatever the keyboard layout", () => {
    expect(decideKey(key({ code: "KeyV", key: "м", keyCode: 86, ctrlKey: true }), false)).toBe("paste");
  });

  it("leaves Ctrl+V to the browser paste when V is not on the QWERTY V key", () => {
    expect(decideKey(key({ code: "Period", key: "v", keyCode: 86, ctrlKey: true }), false)).toBe("paste");
  });

  it("sends to the terminal the Ctrl key typed on the QWERTY V key when that key is not V", () => {
    expect(decideKey(key({ code: "KeyV", key: "k", keyCode: 75, ctrlKey: true }), false)).toBe("terminal");
  });

  it("leaves Ctrl+Shift+V to the browser paste", () => {
    expect(
      decideKey(key({ code: "KeyV", key: "V", keyCode: 86, ctrlKey: true, shiftKey: true }), false),
    ).toBe("paste");
  });

  it("sends Ctrl+V with Alt or Meta to the terminal", () => {
    expect(
      decideKey(key({ code: "KeyV", key: "v", keyCode: 86, ctrlKey: true, altKey: true }), false),
    ).toBe("terminal");
    expect(
      decideKey(key({ code: "KeyV", key: "v", keyCode: 86, ctrlKey: true, metaKey: true }), false),
    ).toBe("terminal");
  });

  it("sends a bare V to the terminal", () => {
    expect(decideKey(key({ code: "KeyV", key: "v", keyCode: 86 }), false)).toBe("terminal");
  });

  it("sends Ctrl+C to the terminal when nothing is selected", () => {
    expect(decideKey(key({ code: "KeyC", key: "c", keyCode: 67, ctrlKey: true }), false)).toBe("terminal");
  });

  it("keeps F9 as the marker shortcut", () => {
    expect(decideKey(key({ code: "F9", key: "F9" }), false)).toBe("mark");
    expect(decideKey(key({ type: "keyup", code: "F9", key: "F9" }), false)).toBe("mark");
  });

  it("sends F9 with a modifier to the terminal", () => {
    expect(decideKey(key({ code: "F9", key: "F9", ctrlKey: true }), false)).toBe("terminal");
  });

  it("copies the selection on Ctrl+C instead of sending ^C", () => {
    expect(decideKey(key({ code: "KeyC", key: "c", keyCode: 67, ctrlKey: true }), true)).toBe("copy");
  });

  it("copies the selection on Ctrl+C keyup and keypress too", () => {
    expect(
      decideKey(key({ type: "keyup", code: "KeyC", key: "c", keyCode: 67, ctrlKey: true }), true),
    ).toBe("copy");
    expect(
      decideKey(key({ type: "keypress", code: "KeyC", key: "c", keyCode: 67, ctrlKey: true }), true),
    ).toBe("copy");
  });

  it("copies the selection on Ctrl+C whatever the keyboard layout", () => {
    expect(decideKey(key({ code: "KeyC", key: "с", keyCode: 67, ctrlKey: true }), true)).toBe("copy");
    expect(decideKey(key({ code: "KeyI", key: "c", keyCode: 67, ctrlKey: true }), true)).toBe("copy");
  });

  it("sends Ctrl+Shift+C to the terminal even with a selection, since the browser copies on Ctrl+C only", () => {
    expect(
      decideKey(key({ code: "KeyC", key: "C", keyCode: 67, ctrlKey: true, shiftKey: true }), true),
    ).toBe("terminal");
  });

  it("sends Ctrl+C with Alt or Meta to the terminal even with a selection", () => {
    expect(
      decideKey(key({ code: "KeyC", key: "c", keyCode: 67, ctrlKey: true, altKey: true }), true),
    ).toBe("terminal");
    expect(
      decideKey(key({ code: "KeyC", key: "c", keyCode: 67, ctrlKey: true, metaKey: true }), true),
    ).toBe("terminal");
  });

  it("sends a bare C to the terminal even with a selection", () => {
    expect(decideKey(key({ code: "KeyC", key: "c", keyCode: 67 }), true)).toBe("terminal");
  });

  it("keeps Ctrl+V as paste and F9 as marker when text is selected", () => {
    expect(decideKey(key({ code: "KeyV", key: "v", keyCode: 86, ctrlKey: true }), true)).toBe("paste");
    expect(decideKey(key({ code: "F9", key: "F9" }), true)).toBe("mark");
  });
});

describe("isToolsShortcut", () => {
  const ctrlShiftD = key({ code: "KeyD", key: "D", keyCode: 68, ctrlKey: true, shiftKey: true });

  it("matches the keydown of Ctrl+Shift+D", () => {
    expect(isToolsShortcut({ ...ctrlShiftD })).toBe(true);
  });

  it("matches on the virtual key code, whatever the layout puts on the key", () => {
    expect(isToolsShortcut({ ...ctrlShiftD, code: "KeyQ", key: "Q" })).toBe(true);
  });

  it("ignores the keyup", () => {
    expect(isToolsShortcut({ ...ctrlShiftD, type: "keyup" })).toBe(false);
  });

  it("ignores Ctrl+D, Ctrl+Alt+Shift+D and Shift+D", () => {
    expect(isToolsShortcut({ ...ctrlShiftD, shiftKey: false })).toBe(false);
    expect(isToolsShortcut({ ...ctrlShiftD, altKey: true })).toBe(false);
    expect(isToolsShortcut({ ...ctrlShiftD, ctrlKey: false })).toBe(false);
  });

  it("ignores Ctrl+Shift+D held with the Meta key, and Ctrl+Shift with another key", () => {
    expect(isToolsShortcut({ ...ctrlShiftD, metaKey: true })).toBe(false);
    expect(isToolsShortcut({ ...ctrlShiftD, code: "KeyF", key: "F", keyCode: 70 })).toBe(false);
  });
});
