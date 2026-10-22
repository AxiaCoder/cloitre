import { describe, expect, it } from "vitest";

import { TabModel } from "./tabs";

describe("TabModel.open", () => {
  it("gives ids from 1 upwards across every project", () => {
    const model = new TabModel();
    expect(model.open(10).id).toBe(1);
    expect(model.open(20).id).toBe(2);
    expect(model.open(10).id).toBe(3);
  });

  it("never reuses the id of a closed tab", () => {
    const model = new TabModel();
    model.open(10);
    const second = model.open(10);
    model.close(second.id);
    expect(model.open(10).id).toBe(3);
  });

  it("numbers the labels within each project", () => {
    const model = new TabModel();
    expect(model.open(10).label).toBe("Session 1");
    expect(model.open(20).label).toBe("Session 1");
    expect(model.open(10).label).toBe("Session 2");
  });

  it("keeps counting labels after a close", () => {
    const model = new TabModel();
    model.open(10);
    const second = model.open(10);
    model.close(second.id);
    expect(model.open(10).label).toBe("Session 3");
  });

  it("opens the tab as starting and makes it the project's active tab", () => {
    const model = new TabModel();
    model.open(10);
    const second = model.open(10);
    expect(second.state).toBe("starting");
    expect(model.activeOf(10)?.id).toBe(second.id);
  });

  it("leaves the other projects' active tabs alone", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.open(20);
    expect(model.activeOf(10)?.id).toBe(first.id);
  });
});

describe("TabModel.close", () => {
  it("makes the next tab active when the active one closes", () => {
    const model = new TabModel();
    const first = model.open(10);
    const second = model.open(10);
    model.open(10);
    model.activate(first.id);
    expect(model.close(first.id)?.active?.id).toBe(second.id);
    expect(model.activeOf(10)?.id).toBe(second.id);
  });

  it("falls back to the previous tab when the last one closes", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.open(20);
    const third = model.open(10);
    expect(model.close(third.id)?.active?.id).toBe(first.id);
  });

  it("keeps the active tab when another one closes", () => {
    const model = new TabModel();
    const first = model.open(10);
    const second = model.open(10);
    expect(model.close(first.id)?.active?.id).toBe(second.id);
  });

  it("leaves no active tab when the project's only tab closes", () => {
    const model = new TabModel();
    const only = model.open(10);
    expect(model.close(only.id)).toEqual({ closed: only, active: undefined });
    expect(model.activeOf(10)).toBeUndefined();
    expect(model.tabsOf(10)).toEqual([]);
  });

  it("ignores an unknown id", () => {
    const model = new TabModel();
    model.open(10);
    expect(model.close(9)).toBeUndefined();
    expect(model.tabsOf(10)).toHaveLength(1);
  });

  it("never touches another project's tabs", () => {
    const model = new TabModel();
    const other = model.open(20);
    const mine = model.open(10);
    model.close(mine.id);
    expect(model.tabsOf(20)).toEqual([other]);
    expect(model.activeOf(20)?.id).toBe(other.id);
  });
});

describe("TabModel.activate and setState", () => {
  it("activates a tab of its own project", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.open(10);
    model.activate(first.id);
    expect(model.activeOf(10)?.id).toBe(first.id);
  });

  it("ignores an unknown id", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.activate(9);
    model.setState(9, "exited");
    expect(model.activeOf(10)?.id).toBe(first.id);
    expect(model.find(first.id)?.state).toBe("starting");
  });

  it("moves a tab through its states", () => {
    const model = new TabModel();
    const tab = model.open(10);
    model.setState(tab.id, "running");
    expect(model.find(tab.id)?.state).toBe("running");
    model.setState(tab.id, "exited");
    expect(model.find(tab.id)?.state).toBe("exited");
  });

  it("lists a project's tabs in opening order", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.open(20);
    const third = model.open(10);
    expect(model.tabsOf(10).map((tab) => tab.id)).toEqual([first.id, third.id]);
  });
});
