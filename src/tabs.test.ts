import { describe, expect, it } from "vitest";

import { afterRefusedStart, TabModel } from "./tabs";

describe("TabModel.open", () => {
  it("keeps the id Rust gave the tab", () => {
    const model = new TabModel();
    expect(model.open(10, 101).id).toBe(101);
    expect(model.find(101)).toMatchObject({ kind: "session", projectId: 10 });
  });

  it("numbers the labels within each project", () => {
    const model = new TabModel();
    expect(model.open(10, 107).label).toBe("Session 1");
    expect(model.open(20, 108).label).toBe("Session 1");
    expect(model.open(10, 109).label).toBe("Session 2");
  });

  it("keeps counting labels after a close", () => {
    const model = new TabModel();
    model.open(10, 110);
    const second = model.open(10, 111);
    model.close(second.id);
    expect(model.open(10, 112).label).toBe("Session 3");
  });

  it("opens the tab as starting and makes it the project's active tab", () => {
    const model = new TabModel();
    model.open(10, 113);
    const second = model.open(10, 114);
    expect(second.state).toBe("starting");
    expect(model.activeOf(10)?.id).toBe(second.id);
  });

  it("leaves the other projects' active tabs alone", () => {
    const model = new TabModel();
    const first = model.open(10, 115);
    model.open(20, 116);
    expect(model.activeOf(10)?.id).toBe(first.id);
  });
});

describe("TabModel.close", () => {
  it("makes the next tab active when the active one closes", () => {
    const model = new TabModel();
    const first = model.open(10, 117);
    const second = model.open(10, 118);
    model.open(10, 119);
    model.activate(first.id);
    expect(model.close(first.id)?.active?.id).toBe(second.id);
    expect(model.activeOf(10)?.id).toBe(second.id);
  });

  it("falls back to the previous tab when the last one closes", () => {
    const model = new TabModel();
    const first = model.open(10, 120);
    model.open(20, 121);
    const third = model.open(10, 122);
    expect(model.close(third.id)?.active?.id).toBe(first.id);
  });

  it("keeps the active tab when another one closes", () => {
    const model = new TabModel();
    const first = model.open(10, 123);
    const second = model.open(10, 124);
    expect(model.close(first.id)?.active?.id).toBe(second.id);
  });

  it("leaves no active tab when the project's only tab closes", () => {
    const model = new TabModel();
    const only = model.open(10, 125);
    expect(model.close(only.id)).toEqual({ closed: only, active: undefined });
    expect(model.activeOf(10)).toBeUndefined();
    expect(model.tabsOf(10)).toEqual([]);
  });

  it("ignores an unknown id", () => {
    const model = new TabModel();
    model.open(10, 126);
    expect(model.close(9)).toBeUndefined();
    expect(model.tabsOf(10)).toHaveLength(1);
  });

  it("never touches another project's tabs", () => {
    const model = new TabModel();
    const other = model.open(20, 127);
    const mine = model.open(10, 128);
    model.close(mine.id);
    expect(model.tabsOf(20)).toEqual([other]);
    expect(model.activeOf(20)?.id).toBe(other.id);
  });
});

describe("TabModel.activate and setState", () => {
  it("activates a tab of its own project", () => {
    const model = new TabModel();
    const first = model.open(10, 129);
    model.open(10, 130);
    model.activate(first.id);
    expect(model.activeOf(10)?.id).toBe(first.id);
  });

  it("ignores an unknown id", () => {
    const model = new TabModel();
    const first = model.open(10, 131);
    model.activate(9);
    model.setState(9, "exited");
    expect(model.activeOf(10)?.id).toBe(first.id);
    expect(model.find(first.id)).toMatchObject({ state: "starting" });
  });

  it("moves a tab through its states, back to starting on a restart", () => {
    const model = new TabModel();
    const tab = model.open(10, 132);
    model.setState(tab.id, "running");
    expect(model.find(tab.id)).toMatchObject({ state: "running" });
    model.setState(tab.id, "exited");
    expect(model.find(tab.id)).toMatchObject({ state: "exited" });
    model.setState(tab.id, "starting");
    expect(model.find(tab.id)).toMatchObject({ id: tab.id, state: "starting" });
  });

  it("lists a project's tabs in opening order", () => {
    const model = new TabModel();
    const first = model.open(10, 133);
    model.open(20, 134);
    const third = model.open(10, 135);
    expect(model.tabsOf(10).map((tab) => tab.id)).toEqual([first.id, third.id]);
  });
});

describe("TabModel replay tabs", () => {
  it("opens a session tab marked as such", () => {
    const model = new TabModel();
    expect(model.open(10, 136).kind).toBe("session");
  });

  it("opens a replay tab labelled with its recording and makes it active", () => {
    const model = new TabModel();
    model.open(10, 137);
    const replay = model.openReplay(10, "one.rec");
    expect(replay).toEqual({ kind: "replay", id: -1, projectId: 10, label: "Replay one.rec", recording: "one.rec" });
    expect(model.activeOf(10)?.id).toBe(replay.id);
    expect(model.replayTab()?.id).toBe(replay.id);
  });

  it("reuses the project's replay tab for another recording", () => {
    const model = new TabModel();
    const replay = model.openReplay(10, "one.rec");
    const session = model.open(10, 138);
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
    expect(model.open(10, 139).label).toBe("Session 1");
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

describe("TabModel replay ids", () => {
  it("gives replay tabs negative ids, never reused, apart from every session tab id", () => {
    const model = new TabModel();
    const first = model.openReplay(10, "one.rec");
    model.close(first.id);
    const second = model.openReplay(10, "one.rec");
    expect([first.id, second.id]).toEqual([-1, -2]);
    model.open(10, 1);
    expect(model.find(1)?.kind).toBe("session");
    expect(model.find(-2)?.kind).toBe("replay");
  });
});

describe("TabModel.restore", () => {
  it("reopens a project's tabs in order, restored, labelled from Session 1", () => {
    const model = new TabModel();
    const restored = model.restore(10, [4, 9]);
    expect(restored).toEqual([
      { kind: "session", id: 4, projectId: 10, label: "Session 1", state: "restored" },
      { kind: "session", id: 9, projectId: 10, label: "Session 2", state: "restored" },
    ]);
    expect(model.tabsOf(10)).toEqual(restored);
  });

  it("numbers each project on its own", () => {
    const model = new TabModel();
    model.restore(10, [1, 2]);
    expect(model.restore(20, [3]).map((tab) => tab.label)).toEqual(["Session 1"]);
  });

  it("makes the first restored tab active", () => {
    const model = new TabModel();
    model.restore(10, [4, 9]);
    expect(model.activeOf(10)?.id).toBe(4);
  });

  it("keeps the active tab of a project that already has one", () => {
    const model = new TabModel();
    model.open(10, 2);
    model.restore(10, [5]);
    expect(model.activeOf(10)?.id).toBe(2);
  });

  it("goes on numbering after the restored tabs", () => {
    const model = new TabModel();
    model.restore(10, [4, 9]);
    expect(model.open(10, 12).label).toBe("Session 3");
  });

  it("restores nothing and activates nothing for no tab", () => {
    const model = new TabModel();
    expect(model.restore(10, [])).toEqual([]);
    expect(model.activeOf(10)).toBeUndefined();
  });

  it("moves a restored tab to starting on resume", () => {
    const model = new TabModel();
    model.restore(10, [4]);
    model.setState(4, "starting");
    expect(model.find(4)).toMatchObject({ state: "starting" });
  });
});

describe("afterRefusedStart", () => {
  it("keeps a tab that is gone", () => {
    expect(afterRefusedStart(undefined, undefined)).toBe("keep");
    expect(afterRefusedStart(undefined, "restored")).toBe("keep");
  });

  it("keeps a newly opened tab whose start failed, so its error stays shown", () => {
    expect(afterRefusedStart("failed", undefined)).toBe("keep");
  });

  it("closes a newly opened tab whose start did not fail", () => {
    expect(afterRefusedStart("starting", undefined)).toBe("close");
    expect(afterRefusedStart("exited", undefined)).toBe("close");
  });

  it("puts a restarted tab still starting back in its previous state", () => {
    expect(afterRefusedStart("starting", "restored")).toBe("restore");
    expect(afterRefusedStart("starting", "exited")).toBe("restore");
  });

  it("keeps a restarted tab whose start failed", () => {
    expect(afterRefusedStart("failed", "exited")).toBe("keep");
  });

  it("keeps a restarted tab another start or a stop moved on", () => {
    expect(afterRefusedStart("running", "restored")).toBe("keep");
    expect(afterRefusedStart("exited", "restored")).toBe("keep");
  });
});
