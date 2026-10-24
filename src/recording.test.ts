/// <reference types="node" />

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  Replay,
  decodeRecording,
  type RecordingEvent,
  type ReplayTarget,
} from "./recording";
import type { PtySession } from "./pty";

/** Encodes one record the way Rust writes it. */
function record(at: number, kind: number, data: number[]): number[] {
  const header = new DataView(new ArrayBuffer(13));
  header.setBigUint64(0, BigInt(at), true);
  header.setUint8(8, kind);
  header.setUint32(9, data.length, true);
  return [...new Uint8Array(header.buffer), ...data];
}

/** Encodes a resize record of `cols` x `rows`. */
function resize(at: number, cols: number, rows: number): number[] {
  return record(at, 2, [cols & 0xff, cols >> 8, rows & 0xff, rows >> 8]);
}

/** A target that logs every call; `drained` resolves at once. */
function logTarget() {
  const log: string[] = [];
  const target: ReplayTarget = {
    reset: () => log.push("reset"),
    resize: (cols, rows) => log.push(`resize ${String(cols)}x${String(rows)}`),
    write: (data) => log.push(`write ${new TextDecoder().decode(data)}`),
    drained: () => {
      log.push("drained");
      return Promise.resolve();
    },
  };
  return { log, target };
}

const text = (value: string) => [...new TextEncoder().encode(value)];

describe("decodeRecording", () => {
  it("decodes output, resize and marker records in order", () => {
    const bytes = Uint8Array.from([
      ...resize(0, 300, 24),
      ...record(5, 1, text("ab")),
      ...record(5, 1, [0xe2, 0x94]),
      ...record(7, 3, []),
      ...record(4_294_967_396, 1, []),
    ]);
    const { events, truncated } = decodeRecording(bytes);
    expect(truncated).toBe(false);
    expect(events).toEqual([
      { kind: "resize", at: 0, cols: 300, rows: 24 },
      { kind: "output", at: 5, data: Uint8Array.from(text("ab")) },
      { kind: "output", at: 5, data: Uint8Array.from([0xe2, 0x94]) },
      { kind: "marker", at: 7 },
      { kind: "output", at: 4_294_967_396, data: new Uint8Array() },
    ]);
  });

  it("decodes an empty file as no record", () => {
    expect(decodeRecording(new Uint8Array())).toEqual({ events: [], truncated: false });
  });

  it("drops an incomplete last record and flags it", () => {
    const whole = [...resize(0, 80, 24), ...record(1, 1, text("hello"))];
    for (const cut of [whole.length - 1, 17 + 13 - 1, 17 + 3]) {
      const { events, truncated } = decodeRecording(Uint8Array.from(whole.slice(0, cut)));
      expect(truncated).toBe(true);
      expect(events).toEqual([{ kind: "resize", at: 0, cols: 80, rows: 24 }]);
    }
  });

  it("reads records from a view that does not start the buffer", () => {
    const buffer = Uint8Array.from([9, 9, ...record(3, 3, [])]);
    expect(decodeRecording(buffer.subarray(2)).events).toEqual([{ kind: "marker", at: 3 }]);
  });

  it("refuses an unknown record type or a malformed resize", () => {
    expect(() => decodeRecording(Uint8Array.from(record(0, 9, [])))).toThrow("unknown record type 9");
    expect(() => decodeRecording(Uint8Array.from(record(0, 2, [1, 2])))).toThrow("resize record of 2 bytes");
  });
});

const events: RecordingEvent[] = [
  { kind: "resize", at: 0, cols: 80, rows: 24 },
  { kind: "output", at: 10, data: Uint8Array.from(text("a")) },
  { kind: "output", at: 10, data: Uint8Array.from(text("b")) },
  { kind: "resize", at: 30, cols: 100, rows: 30 },
  { kind: "output", at: 40, data: Uint8Array.from(text("c")) },
  { kind: "marker", at: 50 },
  { kind: "output", at: 60, data: Uint8Array.from(text("d")) },
  { kind: "marker", at: 70 },
  { kind: "output", at: 75, data: Uint8Array.from(text("e")) },
];

describe("Replay", () => {
  it("resets, then writes every chunk in order and resizes after draining", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target);
    expect(await replay.run("instant", false)).toBe("end");
    expect(log).toEqual([
      "reset",
      "drained",
      "resize 80x24",
      "write a",
      "write b",
      "drained",
      "resize 100x30",
      "write c",
      "write d",
      "write e",
      "drained",
    ]);
    expect(replay.finished).toBe(true);
  });

  it("pauses on each marker, then resumes after it", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target);
    expect(await replay.run("instant", true)).toBe("marker");
    expect(log.filter((line) => line.startsWith("write"))).toEqual(["write a", "write b", "write c"]);
    expect(log[log.length - 1]).toBe("drained");
    log.length = 0;
    expect(await replay.run("instant", true)).toBe("marker");
    expect(log).toEqual(["write d", "drained"]);
    log.length = 0;
    expect(await replay.run("instant", true)).toBe("end");
    expect(log).toEqual(["write e", "drained"]);
    expect(await replay.run("instant", true)).toBe("end");
  });

  it("waits the recorded delays in real time", async () => {
    const { log, target } = logTarget();
    const waits: number[] = [];
    const replay = new Replay(events, target, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    expect(await replay.run("realtime", false)).toBe("end");
    expect(waits).toEqual([10, 20, 10, 10, 10, 10, 5]);
    expect(log.filter((line) => line.startsWith("write"))).toEqual([
      "write a",
      "write b",
      "write c",
      "write d",
      "write e",
    ]);
  });

  it("stops a real-time run, and a later run resumes where it stopped", async () => {
    const { log, target } = logTarget();
    let release: (() => void) | undefined;
    const replay = new Replay(events, target, (_ms, signal) => {
      return new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
    });
    const running = replay.run("realtime", false);
    await vi.waitFor(() => {
      expect(release).toBeDefined();
    });
    await replay.stop();
    expect(await running).toBe("stopped");
    expect(log.filter((line) => line.startsWith("write"))).toEqual([]);
    expect(await replay.run("instant", false)).toBe("end");
    expect(log.filter((line) => line.startsWith("write"))).toEqual([
      "write a",
      "write b",
      "write c",
      "write d",
      "write e",
    ]);
    expect(log.filter((line) => line === "reset")).toHaveLength(1);
  });
});

describe("decodeRecording on the file written by the Rust recorder tests", () => {
  it("decodes the shared fixture to the records Rust wrote", () => {
    const fixture = new Uint8Array(readFileSync(new URL("../fixtures/recording.rec", import.meta.url)));
    expect(decodeRecording(fixture)).toEqual({
      events: [
        { kind: "resize", at: 0, cols: 80, rows: 24 },
        { kind: "output", at: 12, data: Uint8Array.from(text("\x1b[2Jhello")) },
        { kind: "output", at: 12, data: Uint8Array.from([0xe2, 0x94]) },
        { kind: "output", at: 13, data: Uint8Array.from([0x80]) },
        { kind: "resize", at: 20, cols: 300, rows: 40 },
        { kind: "marker", at: 25 },
        { kind: "output", at: 30, data: new Uint8Array() },
      ],
      truncated: false,
    });
  });
});

describe("Replay runs", () => {
  it("lets a new run stop the one still going and resume where it stopped", async () => {
    const { log, target } = logTarget();
    let waiting = false;
    const replay = new Replay(events, target, (_ms, signal) => {
      waiting = true;
      return new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
    });
    const first = replay.run("realtime", false);
    await vi.waitFor(() => {
      expect(waiting).toBe(true);
    });
    const second = replay.run("instant", false);
    expect(await first).toBe("stopped");
    expect(await second).toBe("end");
    expect(log.filter((line) => line.startsWith("write"))).toEqual([
      "write a",
      "write b",
      "write c",
      "write d",
      "write e",
    ]);
    expect(log.filter((line) => line === "reset")).toHaveLength(1);
  });

  it("lets the target draw what was written before waiting in real time", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target, (ms) => {
      log.push(`wait ${String(ms)}`);
      return Promise.resolve();
    });
    await replay.run("realtime", false);
    const waits = log.flatMap((line, index) => (line.startsWith("wait") ? [index] : []));
    expect(waits).toHaveLength(7);
    for (const index of waits) {
      expect(log[index - 1]).toBe("drained");
    }
  });

  it("stops at a marker in real time too", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target, () => Promise.resolve());
    expect(await replay.run("realtime", true)).toBe("marker");
    expect(log.filter((line) => line.startsWith("write"))).toEqual(["write a", "write b", "write c"]);
    expect(replay.finished).toBe(false);
  });

  it("stops a run before it started playing", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target);
    const run = replay.run("instant", false);
    await replay.stop();
    expect(await run).toBe("stopped");
    expect(log).toEqual([]);
  });

  it("stops a run queued behind one that waits for the target to drain", async () => {
    const { log, target } = logTarget();
    let release: () => void = () => undefined;
    const draining = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replay = new Replay(events, {
      ...target,
      drained: () => {
        log.push("drained");
        return draining;
      },
    });
    const first = replay.run("instant", false);
    await vi.waitFor(() => {
      expect(log).toContain("drained");
    });
    const second = replay.run("instant", false);
    const stopped = replay.stop();
    release();
    await stopped;
    expect(await first).toBe("stopped");
    expect(await second).toBe("stopped");
    expect(log.filter((line) => line.startsWith("write"))).toEqual([]);
  });

  it("resolves a stop with no run going", async () => {
    const { log, target } = logTarget();
    const replay = new Replay(events, target);
    await replay.stop();
    expect(log).toEqual([]);
  });
});

describe("recording commands", () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** Loads a fresh copy of the module, with `recording_enabled` answering `answer`. */
  async function freshModule(answer: boolean | Error) {
    const core = await import("@tauri-apps/api/core");
    const mocked = vi.mocked(core.invoke);
    mocked.mockReset();
    mocked.mockImplementation((command) => {
      if (command !== "recording_enabled") {
        return Promise.resolve([]);
      }
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    });
    return { invoke: mocked, recording: await import("./recording") };
  }

  it("are never sent to Rust when Rust says the build records nothing", async () => {
    const { invoke: sent, recording } = await freshModule(false);
    const session = { id: 1 } as PtySession;
    expect(recording.recordingAvailable()).toBe(false);
    await expect(recording.listRecordings()).resolves.toEqual([]);
    await expect(recording.currentRecording(session)).resolves.toBeNull();
    await expect(recording.markRecording(session)).resolves.toBeUndefined();
    await expect(recording.readRecording("20261021-100000.rec")).rejects.toThrow("development build");
    expect(recording.recordingAvailable()).toBe(false);
    expect(sent.mock.calls).toEqual([["recording_enabled"]]);
  });

  it("are sent to Rust when Rust says the build records, after asking it once", async () => {
    const { invoke: sent, recording } = await freshModule(true);
    const session = { id: 1 } as PtySession;
    expect(recording.recordingAvailable()).toBe(false);
    await recording.listRecordings();
    await recording.currentRecording(session);
    await recording.markRecording(session);
    expect(recording.recordingAvailable()).toBe(true);
    expect(sent.mock.calls).toEqual([
      ["recording_enabled"],
      ["recording_list"],
      ["recording_current", { id: 1 }],
      ["recording_mark", { id: 1 }],
    ]);
  });

  it("are never sent to Rust when the question fails", async () => {
    const { invoke: sent, recording } = await freshModule(new Error("unknown command"));
    await expect(recording.loadRecordingAvailability()).resolves.toBe(false);
    await expect(recording.listRecordings()).resolves.toEqual([]);
    expect(sent.mock.calls).toEqual([["recording_enabled"]]);
  });
});
