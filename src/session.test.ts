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
    await vi.waitFor(() => {
      expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    });
    expect(seen.exits).toEqual([3]);
    expect(slot.current).toBeUndefined();
  });

  it("still forwards output that arrives after the exit notice", async () => {
    const slot = new SessionSlot();
    const seen = recorder();
    await slot.start("/projects/a", size, seen.handlers);
    spawns[0]?.onExit.onmessage(0);
    spawns[0]?.onOutput.onmessage([1]);
    expect(seen.output).toEqual([[1]]);
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

/** Makes every later `pty_spawn` wait until the test calls the returned resolver at its rank. */
function deferSpawns(): ((id: number) => void)[] {
  const pending: ((id: number) => void)[] = [];
  tauri.invoke.mockImplementation((command, args) => {
    if (command === "pty_spawn") {
      spawns.push(args as SpawnArgs);
      return new Promise((resolve) => pending.push(resolve));
    }
    return Promise.resolve();
  });
  return pending;
}

describe("SessionSlot.start, overlapping", () => {
  it("kills the first session when its spawn resolves after a second start", async () => {
    const slot = new SessionSlot();
    const pending = deferSpawns();
    const first = slot.start("/projects/a", size, recorder().handlers);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    const second = slot.start("/projects/b", size, recorder().handlers);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    pending[0]?.(1);
    pending[1]?.(2);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    expect(slot.current).toEqual({ id: 2 });
  });

  it("keeps the second session when the first spawn resolves last", async () => {
    const slot = new SessionSlot();
    const pending = deferSpawns();
    const first = slot.start("/projects/a", size, recorder().handlers);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    const second = slot.start("/projects/b", size, recorder().handlers);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    pending[1]?.(2);
    await expect(second).resolves.toBe(true);
    pending[0]?.(1);
    await expect(first).resolves.toBe(false);
    expect(calls("pty_kill")).toEqual([{ id: 1 }]);
    expect(slot.current).toEqual({ id: 2 });
  });

  it("resends a size that changed while the session was starting", async () => {
    const slot = new SessionSlot();
    const pending = deferSpawns();
    const started = slot.start("/projects/a", size, recorder().handlers);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    await slot.resize({ cols: 100, rows: 30 });
    pending[0]?.(1);
    await expect(started).resolves.toBe(true);
    expect(calls("pty_resize")).toEqual([{ id: 1, cols: 100, rows: 30 }]);
  });
  it("does not spawn a session started just before another one", async () => {
    const slot = new SessionSlot();
    const pending = deferSpawns();
    const first = slot.start("/projects/a", size, recorder().handlers);
    const second = slot.start("/projects/b", size, recorder().handlers);
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    pending[0]?.(1);
    await expect(second).resolves.toBe(true);
    expect(spawns.map(({ folder }) => folder)).toEqual(["/projects/b"]);
    expect(slot.current).toEqual({ id: 1 });
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

  it("sends writes in order when an earlier one is slow", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    let finishFirst: () => void = () => undefined;
    tauri.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const first = slot.write("a");
    const second = slot.write("b");
    await vi.waitFor(() => {
      expect(calls("pty_write")).toEqual([{ id: 1, data: "a" }]);
    });
    finishFirst();
    await first;
    await second;
    expect(calls("pty_write")).toEqual([
      { id: 1, data: "a" },
      { id: 1, data: "b" },
    ]);
  });

  it("pass a rejected write to its caller and still send the next one", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockRejectedValueOnce(new Error("write failed"));
    const first = slot.write("a");
    const second = slot.write("b");
    await expect(first).rejects.toThrow("write failed");
    await expect(second).resolves.toBeUndefined();
    expect(calls("pty_write")).toEqual([
      { id: 1, data: "a" },
      { id: 1, data: "b" },
    ]);
  });

  it("sends resizes in order when an earlier one is slow", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    let finishFirst: () => void = () => undefined;
    tauri.invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const first = slot.resize({ cols: 100, rows: 30 });
    const second = slot.resize({ cols: 120, rows: 40 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls("pty_resize")).toEqual([{ id: 1, cols: 100, rows: 30 }]);
    finishFirst();
    await first;
    await second;
    expect(calls("pty_resize")).toEqual([
      { id: 1, cols: 100, rows: 30 },
      { id: 1, cols: 120, rows: 40 },
    ]);
  });

  it("pass a rejected resize to its caller and still send the next one", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockRejectedValueOnce(new Error("resize failed"));
    const first = slot.resize({ cols: 100, rows: 30 });
    const second = slot.resize({ cols: 120, rows: 40 });
    await expect(first).rejects.toThrow("resize failed");
    await expect(second).resolves.toBeUndefined();
    expect(calls("pty_resize")).toEqual([
      { id: 1, cols: 100, rows: 30 },
      { id: 1, cols: 120, rows: 40 },
    ]);
  });

  it("pass a Rust refusal on to the caller", async () => {
    const slot = new SessionSlot();
    await slot.start("/projects/a", size, recorder().handlers);
    tauri.invoke.mockRejectedValue(new Error("invalid size"));
    await expect(slot.resize({ cols: 0, rows: 30 })).rejects.toThrow("invalid size");
  });
});
