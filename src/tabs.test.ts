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
    expect(model.find(first.id)).toMatchObject({ state: "starting" });
  });

  it("moves a tab through its states, back to starting on a restart", () => {
    const model = new TabModel();
    const tab = model.open(10);
    model.setState(tab.id, "running");
    expect(model.find(tab.id)).toMatchObject({ state: "running" });
    model.setState(tab.id, "exited");
    expect(model.find(tab.id)).toMatchObject({ state: "exited" });
    model.setState(tab.id, "starting");
    expect(model.find(tab.id)).toMatchObject({ id: tab.id, state: "starting" });
  });

  it("lists a project's tabs in opening order", () => {
    const model = new TabModel();
    const first = model.open(10);
    model.open(20);
    const third = model.open(10);
    expect(model.tabsOf(10).map((tab) => tab.id)).toEqual([first.id, third.id]);
  });
});

describe("TabModel replay tabs", () => {
  it("opens a session tab marked as such", () => {
    const model = new TabModel();
    expect(model.open(10).kind).toBe("session");
  });

  it("opens a replay tab labelled with its recording and makes it active", () => {
    const model = new TabModel();
    model.open(10);
    const replay = model.openReplay(10, "one.rec");
    expect(replay).toEqual({ kind: "replay", id: 2, projectId: 10, label: "Replay one.rec", recording: "one.rec" });
    expect(model.activeOf(10)?.id).toBe(replay.id);
    expect(model.replayTab()?.id).toBe(replay.id);
  });

  it("reuses the project's replay tab for another recording", () => {
    const model = new TabModel();
    const replay = model.openReplay(10, "one.rec");
    const session = model.open(10);
    expect(model.activeOf(10)?.id).toBe(session.id);
    const again = model.openReplay(10, "two.rec");
    expect(again.id).toBe(replay.id);
    expect(again.label).toBe("Replay two.rec");
    expect(model.tabsOf(10)).toHaveLength(2);
    expect(model.activeOf(10)?.id).toBe(replay.id);
  });

  it("opens a separate replay tab in another project", () => {
    const model = new TabModel();
    const first = model.openReplay(10, "one.rec");
    const second = model.openReplay(20, "one.rec");
    expect(second.id).not.toBe(first.id);
    expect(model.tabsOf(20)).toEqual([second]);
  });

  it("does not count replay tabs in the session numbers", () => {
    const model = new TabModel();
    model.openReplay(10, "one.rec");
    expect(model.open(10).label).toBe("Session 1");
  });

  it("leaves a replay tab without a state", () => {
    const model = new TabModel();
    const replay = model.openReplay(10, "one.rec");
    model.setState(replay.id, "exited");
    expect(model.find(replay.id)).not.toHaveProperty("state");
  });

  it("has no replay tab once it is closed", () => {
    const model = new TabModel();
    const replay = model.openReplay(10, "one.rec");
    model.close(replay.id);
    expect(model.replayTab()).toBeUndefined();
    expect(model.activeOf(10)).toBeUndefined();
  });
});
