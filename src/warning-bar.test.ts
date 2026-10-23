import { describe, expect, it } from "vitest";

import { closeWarning, NO_WARNING, warningText, type WarningState } from "./warning-bar";

describe("warningText", () => {
  it("shows nothing when there is nothing to show", () => {
    expect(warningText(NO_WARNING)).toBeUndefined();
  });

  it("shows the load warning until the user closes it", () => {
    const state: WarningState = { ...NO_WARNING, loadWarning: "projects.json was unreadable" };
    expect(warningText(state)).toBe("projects.json was unreadable");
    expect(warningText(closeWarning(state))).toBeUndefined();
  });

  it("keeps an action error when the project list reloads without a warning", () => {
    const failed: WarningState = { ...NO_WARNING, actionError: "Error: refused" };
    const reloaded: WarningState = { ...failed, loadWarning: null };
    expect(warningText(reloaded)).toBe("Error: refused");
  });

  it("shows the action error over the load warning, and the load warning again once the error is closed", () => {
    const state: WarningState = { loadWarning: "unreadable", loadClosed: false, actionError: "Error: refused" };
    expect(warningText(state)).toBe("Error: refused");
    const closed = closeWarning(state);
    expect(closed).toEqual({ loadWarning: "unreadable", loadClosed: false, actionError: undefined });
    expect(warningText(closed)).toBe("unreadable");
  });

  it("shows an action error even after the user closed the load warning", () => {
    const state: WarningState = { loadWarning: "unreadable", loadClosed: true, actionError: "Error: refused" };
    expect(warningText(state)).toBe("Error: refused");
  });
});
