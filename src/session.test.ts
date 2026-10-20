import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => {
  /** Stand-in for the Tauri IPC channel: the test pushes messages through `onmessage`. */
  class FakeChannel {
    onmessage: (payload: never) => void = () => undefined;
  }
  return { FakeChannel, invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>() };
});

vi.mock("@tauri-apps/api/core", () => ({ Channel: tauri.FakeChannel, invoke: tauri.invoke }));

import { SessionSlot } from "./session";

interface SpawnArgs {
  folder: string;
  cols: number;
  rows: number;
  onOutput: { onmessage: (payload: ArrayBuffer | number[]) => void };
  onExit: { onmessage: (code: number) => void };
}

let nextId: number;
let spawns: SpawnArgs[];

/** The arguments of every `invoke` call of `command` made so far. */
function calls(command: string): unknown[] {
  return tauri.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
}

/** Collects what a session reports. */
function recorder() {
  const output: number[][] = [];
  const exits: number[] = [];
  return {
    output,
    exits,
    handlers: {
      onOutput: (bytes: Uint8Array) => output.push([...bytes]),
      onExit: (code: number) => exits.push(code),
    },
  };
}

const size = () => ({ cols: 80, rows: 24 });

beforeEach(() => {
  nextId = 1;
  spawns = [];
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation((command, args) => {
    if (command === "pty_spawn") {
      spawns.push(args as SpawnArgs);
      return Promise.resolve(nextId++);
    }
    return Promise.resolve();
  });
});

describe("SessionSlot.start", () => {
  it("spawns claude in the folder with the size prepare returns, after stopping the previous session", async () => {
    const slot = new SessionSlot();
    const order: string[] = [];
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockClear();
    await slot.start(
      "/projects/b",
      () => {
        order.push(`prepare after ${String(calls("pty_kill").length)} kill`);
        return { cols: 120, rows: 40 };
      },
      recorder().handlers,
    );
    expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    expect(order).toEqual(["prepare after 1 kill"]);
    expect(spawns[1]).toMatchObject({ folder: "/projects/b", cols: 120, rows: 40 });
    expect(slot.current).toEqual({ id: 2 });
  });

  it("forwards output as bytes, from raw and from JSON payloads", async () => {
    const slot = new SessionSlot();
    const seen = recorder();
    await slot.start("/projects/a", size, seen.handlers);
    spawns[0]?.onOutput.onmessage(new Uint8Array([104, 105]).buffer);
    spawns[0]?.onOutput.onmessage([33]);
    expect(seen.output).toEqual([[104, 105], [33]]);
  });

  it("drops output and exit notices of a session that was replaced", async () => {
    const slot = new SessionSlot();
    const first = recorder();
    const second = recorder();
    await slot.start("/projects/a", size, first.handlers);
    await slot.start("/projects/b", size, second.handlers);
    spawns[0]?.onOutput.onmessage([1]);
    spawns[0]?.onExit.onmessage(0);
    spawns[1]?.onOutput.onmessage([2]);
    expect(first.output).toEqual([]);
    expect(first.exits).toEqual([]);
    expect(second.output).toEqual([[2]]);
    expect(slot.current).toEqual({ id: 2 });
  });

  it("drops output of a stopped session", async () => {
    const slot = new SessionSlot();
    const seen = recorder();
    await slot.start("/projects/a", size, seen.handlers);
    await slot.stop();
    spawns[0]?.onOutput.onmessage([1]);
    expect(seen.output).toEqual([]);
  });

  it("reports the exit code once, then releases the session", async () => {
    const slot = new SessionSlot();
    const seen = recorder();
    await slot.start("/projects/a", size, seen.handlers);
    spawns[0]?.onExit.onmessage(3);
    spawns[0]?.onExit.onmessage(3);
    spawns[0]?.onOutput.onmessage([1]);
    await vi.waitFor(() => {
      expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    });
    expect(seen.exits).toEqual([3]);
    expect(seen.output).toEqual([]);
    expect(slot.current).toBeUndefined();
  });

  it("rejects with the Rust refusal and leaves no session", async () => {
    const slot = new SessionSlot();
    tauri.invoke.mockImplementation((command) =>
      command === "pty_spawn" ? Promise.reject(new Error("folder not found")) : Promise.resolve(),
    );
    await expect(slot.start("/missing", size, recorder().handlers)).rejects.toThrow(
      "folder not found",
    );
    expect(slot.current).toBeUndefined();
  });
});

describe("SessionSlot.stop", () => {
  it("does nothing on the Rust side when no session runs", async () => {
    await new SessionSlot().stop();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("ignores a failed kill and still releases the session", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockRejectedValue(new Error("unknown session 1"));
    await expect(slot.stop()).resolves.toBeUndefined();
    expect(slot.current).toBeUndefined();
  });
});

describe("SessionSlot.write and resize", () => {
  it("are no-ops without a session", async () => {
    const slot = new SessionSlot();
    await slot.write("x");
    await slot.resize({ cols: 100, rows: 30 });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("reach the current session", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    await slot.write("hi");
    await slot.resize({ cols: 100, rows: 30 });
    expect(calls("pty_write")).toEqual([{ id: 1, data: "hi" }]);
    expect(calls("pty_resize")).toEqual([{ id: 1, cols: 100, rows: 30 }]);
  });

  it("pass a Rust refusal on to the caller", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockRejectedValue(new Error("invalid size"));
    await expect(slot.resize({ cols: 0, rows: 30 })).rejects.toThrow("invalid size");
  });
});
