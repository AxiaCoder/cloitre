import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { keepAwake, KeepAwakeSync, shouldKeepAwake } from "./keep-awake";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("shouldKeepAwake", () => {
  it("never keeps awake under Never", () => {
    expect(shouldKeepAwake("never", ["working", "blocked"])).toBe(false);
  });

  it("keeps awake for a working session under While a session works", () => {
    expect(shouldKeepAwake("working", [undefined, "working"])).toBe(true);
  });

  it("does not keep awake for a waiting session under While a session works", () => {
    expect(shouldKeepAwake("working", ["blocked", "done", "failed", undefined])).toBe(false);
  });

  it.each(["working", "blocked"] as const)("keeps awake for a %s session under works or waits", (activity) => {
    expect(shouldKeepAwake("working-or-blocked", ["done", activity])).toBe(true);
  });

  it("keeps awake for a working session listed among blocked ones under While a session works", () => {
    expect(shouldKeepAwake("working", ["blocked", "working"])).toBe(true);
  });

  it("reads the activities from any iterable", () => {
    /** Yields a done activity, then a blocked one. */
    function* activities(): Generator<"done" | "blocked"> {
      yield "done";
      yield "blocked";
    }
    expect(shouldKeepAwake("working-or-blocked", activities())).toBe(true);
    expect(shouldKeepAwake("working", activities())).toBe(false);
  });

  it("lets the computer sleep without sessions or with only finished ones", () => {
    expect(shouldKeepAwake("working-or-blocked", [])).toBe(false);
    expect(shouldKeepAwake("working-or-blocked", ["done", "failed", undefined])).toBe(false);
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
