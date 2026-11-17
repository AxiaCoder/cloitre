import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdleClock, isIdle } from "./idle-stop";
import type { SessionActivity } from "./session-activity";

const MINUTE = 60_000;

describe("isIdle", () => {
  it("holds for a running session that shows no activity", () => {
    expect(isIdle("running", undefined)).toBe(true);
  });

  it.each<SessionActivity>(["blocked", "failed", "done", "working"])("does not hold for a session that is %s", (activity) => {
    expect(isIdle("running", activity)).toBe(false);
  });

  it.each(["restored", "starting", "exited", "failed", undefined] as const)(
    "does not hold for a tab in state %s",
    (state) => {
      expect(isIdle(state, undefined)).toBe(false);
    },
  );
});

describe("IdleClock", () => {
  let stopped: number[];

  /** Returns a clock with `delay` that records the tabs it reports in `stopped`. */
  function clock(delay: ConstructorParameters<typeof IdleClock>[0]): IdleClock {
    return new IdleClock(delay, (tabId) => stopped.push(tabId));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    stopped = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports a tab once it has been idle for the delay, and only once", () => {
    const idle = clock(5);
    idle.sync([1]);
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stopped).toEqual([1]);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("keeps the time of a tab listed idle again", () => {
    const idle = clock(5);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    idle.sync([1, 2]);
    vi.advanceTimersByTime(MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("never reports a tab that stops being idle, as a working one with background tasks", () => {
    const idle = clock(5);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    idle.sync([]);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("times a tab afresh once it is idle again", () => {
    const idle = clock(5);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    idle.sync([]);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("restarts the time of a tab on input or activity", () => {
    const idle = clock(5);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    idle.touch(1);
    vi.advanceTimersByTime(4 * MINUTE);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("does not time a tab it is touched for but that is not idle", () => {
    const idle = clock(5);
    idle.touch(1);
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("reports nothing under Never", () => {
    const idle = clock("never");
    idle.sync([1]);
    vi.advanceTimersByTime(24 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("applies a new delay to the tabs it times, from when they became idle", () => {
    const idle = clock(60);
    idle.sync([1]);
    vi.advanceTimersByTime(10 * MINUTE);
    idle.setDelay(15);
    vi.advanceTimersByTime(5 * MINUTE - 1);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stopped).toEqual([1]);
  });

  it("reports at once a tab idle longer than a shorter new delay", () => {
    const idle = clock(60);
    idle.sync([1]);
    vi.advanceTimersByTime(10 * MINUTE);
    idle.setDelay(5);
    vi.advanceTimersByTime(0);
    expect(stopped).toEqual([1]);
  });

  it("stops reporting when the delay becomes Never, and starts again when it is set back", () => {
    const idle = clock(5);
    idle.sync([1]);
    idle.setDelay("never");
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([]);
    idle.setDelay(120);
    vi.advanceTimersByTime(60 * MINUTE - 1);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stopped).toEqual([1]);
  });
});
