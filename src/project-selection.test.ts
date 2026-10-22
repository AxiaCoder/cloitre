import { describe, expect, it } from "vitest";

import { chooseWorkArea, clickAction, keepSelection } from "./project-selection";
import type { Project } from "./projects";

const alpha: Project = { id: 1, name: "alpha", path: "C:\\work\\alpha", exists: true };
const gone: Project = { id: 2, name: "gone", path: "C:\\work\\gone", exists: false };

describe("chooseWorkArea", () => {
  it("shows the empty state when there is no project", () => {
    expect(chooseWorkArea([], undefined)).toEqual({ kind: "empty" });
    expect(chooseWorkArea([], 1)).toEqual({ kind: "empty" });
  });

  it("shows the missing-folder state for a selected project whose folder is gone", () => {
    expect(chooseWorkArea([alpha, gone], 2)).toEqual({ kind: "missing", project: gone });
  });

  it("shows the terminal for a selected project whose folder exists", () => {
    expect(chooseWorkArea([alpha, gone], 1)).toEqual({ kind: "terminal" });
  });

  it("shows the terminal when no project, or an unknown one, is selected", () => {
    expect(chooseWorkArea([alpha, gone], undefined)).toEqual({ kind: "terminal" });
    expect(chooseWorkArea([alpha, gone], 9)).toEqual({ kind: "terminal" });
  });
});

describe("keepSelection", () => {
  it("keeps a selection that is still in the list", () => {
    expect(keepSelection([alpha, gone], 2)).toBe(2);
  });

  it("drops a selection that left the list", () => {
    expect(keepSelection([alpha], 2)).toBeUndefined();
    expect(keepSelection([alpha], undefined)).toBeUndefined();
  });
});

describe("clickAction", () => {
  it("opens a tab in a project without tabs whose folder exists", () => {
    expect(clickAction([alpha, gone], 1, false)).toEqual({ kind: "open", project: alpha });
  });

  it("shows the active tab of a project that has tabs", () => {
    expect(clickAction([alpha], 1, true)).toEqual({ kind: "show" });
  });

  it("shows the missing-folder state for a project whose folder is gone", () => {
    expect(clickAction([alpha, gone], 2, false)).toEqual({ kind: "missing" });
    expect(clickAction([alpha, gone], 2, true)).toEqual({ kind: "missing" });
  });

  it("does nothing for an unknown project", () => {
    expect(clickAction([alpha], 9, false)).toEqual({ kind: "none" });
  });
});
