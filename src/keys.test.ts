import { describe, expect, it } from "vitest";

import { decideKey, type KeyInput } from "./keys";

/** Builds a key event with no modifier, overridden by `fields`. */
function key(fields: Partial<KeyInput>): KeyInput {
  return {
    type: "keydown",
    code: "",
    key: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...fields,
  };
}

describe("decideKey", () => {
  it("leaves Ctrl+V to the browser paste instead of sending ^V", () => {
    expect(decideKey(key({ code: "KeyV", key: "v", ctrlKey: true }))).toBe("paste");
  });

  it("leaves Ctrl+V to the browser paste on keyup too", () => {
    expect(decideKey(key({ type: "keyup", code: "KeyV", key: "v", ctrlKey: true }))).toBe(
      "paste",
    );
  });

  it("sends Ctrl+V with Alt, Shift or Meta to the terminal", () => {
    expect(decideKey(key({ code: "KeyV", key: "v", ctrlKey: true, altKey: true }))).toBe(
      "terminal",
    );
    expect(decideKey(key({ code: "KeyV", key: "V", ctrlKey: true, shiftKey: true }))).toBe(
      "terminal",
    );
    expect(decideKey(key({ code: "KeyV", key: "v", ctrlKey: true, metaKey: true }))).toBe(
      "terminal",
    );
  });

  it("sends a bare V to the terminal", () => {
    expect(decideKey(key({ code: "KeyV", key: "v" }))).toBe("terminal");
  });

  it("sends Ctrl+C to the terminal", () => {
    expect(decideKey(key({ code: "KeyC", key: "c", ctrlKey: true }))).toBe("terminal");
  });

  it("keeps F9 as the marker shortcut", () => {
    expect(decideKey(key({ code: "F9", key: "F9" }))).toBe("mark");
    expect(decideKey(key({ type: "keyup", code: "F9", key: "F9" }))).toBe("mark");
  });

  it("sends F9 with a modifier to the terminal", () => {
    expect(decideKey(key({ code: "F9", key: "F9", ctrlKey: true }))).toBe("terminal");
  });
});
