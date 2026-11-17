import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IdleClock, isIdle } from "./idle-stop";
import { ActivityStore, type ReportedState, type SessionActivity } from "./session-activity";
import type { TabState } from "./tabs";

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

  it("applies a new delay to the tabs it times, from their last activity", () => {
    const idle = clock(60);
    idle.sync([1]);
    vi.advanceTimersByTime(4 * MINUTE);
    idle.touch(1);
    vi.advanceTimersByTime(6 * MINUTE);
    idle.setDelay(15);
    vi.advanceTimersByTime(9 * MINUTE - 1);
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

describe("the idle stop over reported activity", () => {
  let stopped: number[];
  let activities: ActivityStore;
  let states: Map<number, TabState>;
  let idle: IdleClock;

  /** Gives the clock every idle tab, as the page does after each change. */
  function watch(): void {
    idle.sync([...states].flatMap(([tabId, state]) => (isIdle(state, activities.of(tabId)) ? [tabId] : [])));
  }

  /** Applies report `state` to tab `tabId` as the page does: restarts its time, then lists the idle tabs again. */
  function report(tabId: number, state: ReportedState, seen = true): void {
    idle.touch(tabId);
    activities.report(tabId, state, seen);
    watch();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    stopped = [];
    activities = new ActivityStore();
    states = new Map([[1, "running"]]);
    idle = new IdleClock(60, (tabId) => {
      stopped.push(tabId);
      states.set(tabId, "exited");
      watch();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never stops a session whose turn ended with background tasks still running", () => {
    report(1, "prompted");
    report(1, "background");
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("starts the time once the background tasks settle on a tab in view", () => {
    report(1, "prompted");
    report(1, "background");
    vi.advanceTimersByTime(3 * 60 * MINUTE);
    report(1, "settled");
    vi.advanceTimersByTime(60 * MINUTE - 1);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stopped).toEqual([1]);
  });

  it("keeps waiting on background tasks through an interrupt", () => {
    report(1, "prompted");
    report(1, "background");
    activities.interrupt(1);
    watch();
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("never stops a session whose finished turn is not seen yet, and times it once seen", () => {
    report(1, "prompted");
    report(1, "done", false);
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
    activities.see(1);
    watch();
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("never stops a session whose background tasks settled out of view until it is seen", () => {
    report(1, "prompted");
    report(1, "background");
    report(1, "settled", false);
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it.each<ReportedState>(["blocked", "failed", "working"])("never stops a session reported %s", (state) => {
    report(1, state);
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("never stops a session still starting", () => {
    states.set(1, "starting");
    watch();
    vi.advanceTimersByTime(8 * 60 * MINUTE);
    expect(stopped).toEqual([]);
  });

  it("restarts the time on any report, even one that leaves the tab idle", () => {
    report(1, "done");
    vi.advanceTimersByTime(50 * MINUTE);
    report(1, "settled");
    vi.advanceTimersByTime(50 * MINUTE);
    expect(stopped).toEqual([]);
    vi.advanceTimersByTime(10 * MINUTE);
    expect(stopped).toEqual([1]);
  });

  it("times each idle tab on its own", () => {
    states.set(2, "running");
    watch();
    vi.advanceTimersByTime(30 * MINUTE);
    report(2, "prompted");
    vi.advanceTimersByTime(30 * MINUTE);
    expect(stopped).toEqual([1]);
    report(2, "done");
    vi.advanceTimersByTime(60 * MINUTE);
    expect(stopped).toEqual([1, 2]);
  });

  it("reports at once, when Never is set back to a delay already passed, a tab idle all along", () => {
    watch();
    idle.setDelay("never");
    vi.advanceTimersByTime(2 * 60 * MINUTE);
    expect(stopped).toEqual([]);
    idle.setDelay(5);
    vi.advanceTimersByTime(0);
    expect(stopped).toEqual([1]);
  });
});
