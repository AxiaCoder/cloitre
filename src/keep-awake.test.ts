import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { keepAwake, KeepAwakeSync, shouldKeepAwake } from "./keep-awake";
import { ActivityStore } from "./session-activity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const working = { working: true, blocked: false };
const blocked = { working: false, blocked: true };
const idle = { working: false, blocked: false };

describe("shouldKeepAwake", () => {
  it("never keeps awake under Never", () => {
    expect(shouldKeepAwake("never", [working, blocked])).toBe(false);
  });

  it("keeps awake for a working session under While a session works", () => {
    expect(shouldKeepAwake("working", [idle, working])).toBe(true);
  });

  it("does not keep awake for a waiting session under While a session works", () => {
    expect(shouldKeepAwake("working", [blocked, idle])).toBe(false);
  });

  it.each([
    ["working", working],
    ["blocked", blocked],
  ] as const)("keeps awake for a %s session under works or waits", (_name, session) => {
    expect(shouldKeepAwake("working-or-blocked", [idle, session])).toBe(true);
  });

  it("keeps awake for a working session listed among blocked ones under While a session works", () => {
    expect(shouldKeepAwake("working", [blocked, working])).toBe(true);
  });

  it("keeps awake for a session both working and blocked under While a session works", () => {
    expect(shouldKeepAwake("working", [{ working: true, blocked: true }])).toBe(true);
  });

  it("reads the sessions from any iterable", () => {
    /** Yields an idle session, then a blocked one. */
    function* sessions(): Generator<{ working: boolean; blocked: boolean }> {
      yield idle;
      yield blocked;
    }
    expect(shouldKeepAwake("working-or-blocked", sessions())).toBe(true);
    expect(shouldKeepAwake("working", sessions())).toBe(false);
  });

  it("lets the computer sleep without sessions or with only idle ones", () => {
    expect(shouldKeepAwake("working-or-blocked", [])).toBe(false);
    expect(shouldKeepAwake("working-or-blocked", [idle, idle])).toBe(false);
  });
});

describe("shouldKeepAwake from the activity store", () => {
  it("keeps awake under While a session works a tab whose subagent is blocked while its main conversation works", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "working", false);
    store.report(1, "blocked", false, "a1");
    const sessions = [{ working: store.isWorking(1), blocked: store.isBlocked(1) }];
    expect(shouldKeepAwake("working", sessions)).toBe(true);
  });

  it("lets the computer sleep under While a session works when the main conversation is blocked", () => {
    const store = new ActivityStore();
    store.report(1, "prompted", false);
    store.report(1, "blocked", false);
    const sessions = [{ working: store.isWorking(1), blocked: store.isBlocked(1) }];
    expect(shouldKeepAwake("working", sessions)).toBe(false);
    expect(shouldKeepAwake("working-or-blocked", sessions)).toBe(true);
  });
});

describe("keepAwake", () => {
  it("asks Rust with the state", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await keepAwake(true);
    expect(vi.mocked(invoke).mock.calls).toEqual([["keep_awake", { on: true }]]);
  });
});

describe("KeepAwakeSync", () => {
  it("sends the first state, even false, then only changes", async () => {
    const sent: boolean[] = [];
    const sync = new KeepAwakeSync((on) => {
      sent.push(on);
      return Promise.resolve();
    });
    await sync.update(false);
    await sync.update(false);
    await sync.update(true);
    await sync.update(true);
    await sync.update(false);
    expect(sent).toEqual([false, true, false]);
  });

  it("sends a state only after the previous send has settled", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = new KeepAwakeSync(async (on) => {
      events.push(`start ${String(on)}`);
      if (on) {
        await held;
        events.push("end true");
      }
    });
    const first = sync.update(true);
    const second = sync.update(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["start true"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["start true", "end true", "start false"]);
  });

  it("rejects a failed send and still sends the next change", async () => {
    const sent: boolean[] = [];
    const sync = new KeepAwakeSync((on) => {
      sent.push(on);
      return on ? Promise.reject(new Error("refused")) : Promise.resolve();
    });
    await expect(sync.update(true)).rejects.toThrow("refused");
    await sync.update(false);
    expect(sent).toEqual([true, false]);
  });

  it("does not resend a state whose send failed until the state changes", async () => {
    const sent: boolean[] = [];
    const sync = new KeepAwakeSync((on) => {
      sent.push(on);
      return Promise.reject(new Error("refused"));
    });
    await expect(sync.update(true)).rejects.toThrow("refused");
    await sync.update(true);
    expect(sent).toEqual([true]);
  });
});
