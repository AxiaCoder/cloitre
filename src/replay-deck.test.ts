import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { ReplayStop, ReplayTarget } from "./recording";
import { ReplayDeck, type ReplayDeckHooks } from "./replay-deck";

/** Encodes one output record of `text` at `at` ms, the way Rust writes it. */
function output(at: number, text: string): number[] {
  const data = new TextEncoder().encode(text);
  const header = new DataView(new ArrayBuffer(13));
  header.setBigUint64(0, BigInt(at), true);
  header.setUint8(8, 1);
  header.setUint32(9, data.length, true);
  return [...new Uint8Array(header.buffer), ...data];
}

/** A recording that writes "a", then "b" a second later. */
const slowRecording = Uint8Array.from([...output(0, "a"), ...output(1000, "b")]);

/** A target that logs what is written; `drained` resolves at once. */
function logTarget() {
  const log: string[] = [];
  const target: ReplayTarget = {
    reset: () => log.push("reset"),
    resize: () => undefined,
    write: (data) => log.push(new TextDecoder().decode(data)),
    drained: () => Promise.resolve(),
  };
  return { log, target };
}

/** Hooks whose reads resolve only when `deliver(name)` is called. */
function gatedHooks() {
  const pending = new Map<string, () => void>();
  const hooks: ReplayDeckHooks = {
    stopSession: () => Promise.resolve(),
    read: (name) =>
      new Promise((resolve) => {
        pending.set(name, () => {
          resolve(slowRecording);
        });
      }),
    hold: () => undefined,
    release: () => undefined,
  };
  /** Resolves the read of `name`, once it has been asked for. */
  async function deliver(name: string): Promise<void> {
    await vi.waitFor(() => {
      expect(pending.has(name)).toBe(true);
    });
    pending.get(name)?.();
  }
  return { hooks, deliver };
}

describe("ReplayDeck, overlapping", () => {
  it("a load started while another is in flight stops the replay of the first", async () => {
    const { target } = logTarget();
    const { hooks, deliver } = gatedHooks();
    const deck = new ReplayDeck(target, hooks);

    const first = deck.load("one");
    const second = deck.load("two");
    await deliver("one");
    const { replay } = await first;
    let firstStop: ReplayStop | undefined;
    void deck.run(replay, "realtime", false).then((stop) => {
      firstStop = stop;
    });
    await deliver("two");
    const loaded = await second;

    expect(deck.current).toBe(loaded.replay);
    await vi.waitFor(() => {
      expect(firstStop).toBe("stopped");
    });
  });

  it("a claim made while a load is in flight runs once that replay is ended", async () => {
    const { target } = logTarget();
    const { hooks, deliver } = gatedHooks();
    const deck = new ReplayDeck(target, hooks);

    const loading = deck.load("one");
    let seen: unknown = "not run";
    const claimed = deck.claim(() => {
      seen = deck.current;
      return Promise.resolve();
    });
    await deliver("one");
    await Promise.all([loading, claimed]);

    expect(seen).toBeUndefined();
    expect(deck.current).toBeUndefined();
  });

  it("a replay that is no longer on screen does not run", async () => {
    const { log, target } = logTarget();
    const { hooks, deliver } = gatedHooks();
    const deck = new ReplayDeck(target, hooks);

    const loading = deck.load("one");
    await deliver("one");
    const { replay } = await loading;
    await deck.stop();

    expect(await deck.run(replay, "instant", false)).toBe("stopped");
    expect(log).toEqual([]);
  });
});

/** Hooks that log each call and read `bytes`, or reject the reads named in `failing`. */
function loggedHooks(bytes: Uint8Array, failing: string[] = []) {
  const calls: string[] = [];
  const hooks: ReplayDeckHooks = {
    stopSession: () => {
      calls.push("stopSession");
      return Promise.resolve();
    },
    read: (name) => {
      calls.push(`read ${name}`);
      return failing.includes(name) ? Promise.reject(new Error(`cannot read ${name}`)) : Promise.resolve(bytes);
    },
    hold: () => calls.push("hold"),
    release: () => calls.push("release"),
  };
  return { calls, hooks };
}

describe("ReplayDeck, around the page", () => {
  it("stops the session, reads the recording, then holds the screen", async () => {
    const { target } = logTarget();
    const { calls, hooks } = loggedHooks(slowRecording);
    const deck = new ReplayDeck(target, hooks);

    const { replay, truncated } = await deck.load("one");

    expect(calls).toEqual(["stopSession", "read one", "hold"]);
    expect(replay.name).toBe("one");
    expect(replay.marks).toBe(0);
    expect(truncated).toBe(false);
    expect(deck.current).toBe(replay);
  });

  it("tells when the last record of the recording was dropped", async () => {
    const { target } = logTarget();
    const { hooks } = loggedHooks(slowRecording.slice(0, -1));
    const deck = new ReplayDeck(target, hooks);

    expect((await deck.load("one")).truncated).toBe(true);
  });

  it("releases the screen once when the replay on screen is stopped", async () => {
    const { target } = logTarget();
    const { calls, hooks } = loggedHooks(slowRecording);
    const deck = new ReplayDeck(target, hooks);
    await deck.load("one");

    expect(await deck.stop()).toBe(true);
    expect(await deck.stop()).toBe(false);
    expect(calls.filter((call) => call === "release")).toEqual(["release"]);
    expect(deck.current).toBeUndefined();
  });

  it("resolves a stop with no replay on screen as false, without releasing the screen", async () => {
    const { target } = logTarget();
    const { calls, hooks } = loggedHooks(slowRecording);
    const deck = new ReplayDeck(target, hooks);

    expect(await deck.stop()).toBe(false);
    expect(calls).toEqual([]);
  });

  it("releases the screen of the replay a claim ends", async () => {
    const { target } = logTarget();
    const { calls, hooks } = loggedHooks(slowRecording);
    const deck = new ReplayDeck(target, hooks);
    await deck.load("one");

    await deck.claim(() => {
      calls.push("operation");
      return Promise.resolve();
    });

    expect(calls.slice(-2)).toEqual(["release", "operation"]);
  });

  it("rejects a load whose read fails, and still runs the next one", async () => {
    const { target } = logTarget();
    const { hooks } = loggedHooks(slowRecording, ["broken"]);
    const deck = new ReplayDeck(target, hooks);

    const failed = deck.load("broken");
    const next = deck.load("one");

    await expect(failed).rejects.toThrow("cannot read broken");
    expect((await next).replay.name).toBe("one");
    expect(deck.current?.name).toBe("one");
  });
});
