import { describe, expect, it } from "vitest";

import { ActivityStore, parseActivityReport } from "./session-activity";

describe("parseActivityReport", () => {
  it("reads a well-formed payload", () => {
    expect(parseActivityReport({ tab: 3, state: "blocked" })).toEqual({ tab: 3, state: "blocked" });
    expect(parseActivityReport({ tab: 1, state: "working" })).toEqual({ tab: 1, state: "working" });
    expect(parseActivityReport({ tab: 2, state: "done" })).toEqual({ tab: 2, state: "done" });
  });

  it("ignores a state this version does not know", () => {
    expect(parseActivityReport({ tab: 3, state: "error" })).toBeUndefined();
    expect(parseActivityReport({ tab: 3, state: 1 })).toBeUndefined();
    expect(parseActivityReport({ tab: 3 })).toBeUndefined();
    expect(parseActivityReport({ tab: 3, state: "Blocked" })).toBeUndefined();
  });

  it("ignores a tab id that is not a whole number of 1 or more", () => {
    expect(parseActivityReport({ tab: 0, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: -1, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: 1.5, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: "1", state: "done" })).toBeUndefined();
    expect(parseActivityReport({ tab: Number.NaN, state: "done" })).toBeUndefined();
    expect(parseActivityReport({ state: "done" })).toBeUndefined();
  });

  it("ignores a payload that is not an object", () => {
    expect(parseActivityReport(null)).toBeUndefined();
    expect(parseActivityReport("done")).toBeUndefined();
    expect(parseActivityReport(undefined)).toBeUndefined();
  });
});

describe("ActivityStore", () => {
  it("blocks a tab, on screen or not", () => {
    const store = new ActivityStore();
    expect(store.report(1, "blocked", false)).toBe(true);
    expect(store.report(2, "blocked", true)).toBe(true);
    expect(store.of(1)).toBe("blocked");
    expect(store.of(2)).toBe("blocked");
  });

  it("reports no change when a tab is blocked again", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    expect(store.report(1, "blocked", true)).toBe(false);
    expect(store.of(1)).toBe("blocked");
  });

  it("reports no change when a done tab is done again out of sight", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.report(1, "done", false)).toBe(false);
    expect(store.of(1)).toBe("done");
  });

  it("clears a done tab when its next turn ends on screen", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.report(1, "done", true)).toBe(true);
    expect(store.of(1)).toBeUndefined();
  });

  it("does nothing when a tab without activity is seen", () => {
    const store = new ActivityStore();
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBeUndefined();
  });

  it("keeps a blocked tab blocked when it is seen", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    expect(store.see(1)).toBe(false);
    expect(store.of(1)).toBe("blocked");
  });

  it("clears a blocked or done tab on working, showing nothing", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    store.report(2, "done", false);
    expect(store.report(1, "working", true)).toBe(true);
    expect(store.report(2, "working", false)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.of(2)).toBeUndefined();
    expect(store.report(3, "working", false)).toBe(false);
  });

  it("clears a blocked tab on done", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", true);
    expect(store.report(1, "done", true)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    store.report(2, "blocked", false);
    store.report(2, "done", false);
    expect(store.of(2)).toBe("done");
  });

  it("shows done only for a tab not seen", () => {
    const store = new ActivityStore();
    expect(store.report(1, "done", false)).toBe(true);
    expect(store.report(2, "done", true)).toBe(false);
    expect(store.of(1)).toBe("done");
    expect(store.of(2)).toBeUndefined();
  });

  it("puts a done tab out once seen", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    expect(store.see(1)).toBe(true);
    expect(store.of(1)).toBeUndefined();
    expect(store.see(1)).toBe(false);
  });

  it("forgets the activity of a tab", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    store.report(2, "done", false);
    expect(store.forget(1)).toBe(true);
    expect(store.forget(2)).toBe(true);
    expect(store.forget(3)).toBe(false);
    expect(store.of(1)).toBeUndefined();
    expect(store.of(2)).toBeUndefined();
  });

  it("reports blocked before done for a set of tabs", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    store.report(2, "blocked", false);
    expect(store.mostUrgent([1, 2])).toBe("blocked");
    expect(store.mostUrgent([2, 1])).toBe("blocked");
    expect(store.mostUrgent([1, 3])).toBe("done");
    expect(store.mostUrgent([3])).toBeUndefined();
    expect(store.mostUrgent([])).toBeUndefined();
  });

  it("shows done for a set of tabs again once its blocked tab is answered", () => {
    const store = new ActivityStore();
    store.report(1, "done", false);
    store.report(2, "blocked", false);
    store.report(2, "working", false);
    expect(store.mostUrgent([1, 2])).toBe("done");
  });

  it("ignores in a set the tabs of other projects", () => {
    const store = new ActivityStore();
    store.report(1, "blocked", false);
    store.report(2, "done", false);
    expect(store.mostUrgent([2, 3])).toBe("done");
  });
});
