import { describe, expect, it } from "vitest";

import {
  DEFAULT_IDLE_DELAY,
  IDLE_DELAY_KEY,
  IDLE_DELAYS,
  idleDelayValue,
  loadIdleDelay,
  parseIdleDelay,
  saveIdleDelay,
  type SettingsStorage,
} from "./settings";

/** Stand-in for local storage: a map of keys to values. */
class FakeStorage implements SettingsStorage {
  readonly items = new Map<string, string>();
  /** Returns the value of `key`, or `null` when none is stored. */
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  /** Stores `value` under `key`. */
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

describe("the idle delay setting", () => {
  it("offers Never, then 5, 15 and 30 minutes, 1, 2 and 4 hours", () => {
    expect(IDLE_DELAYS).toEqual(["never", 5, 15, 30, 60, 120, 240]);
  });

  it("defaults to 1 hour", () => {
    expect(DEFAULT_IDLE_DELAY).toBe(60);
    expect(loadIdleDelay(new FakeStorage())).toBe(60);
  });

  it.each(IDLE_DELAYS)("reads back %s once stored", (delay) => {
    const storage = new FakeStorage();
    saveIdleDelay(storage, delay);
    expect(loadIdleDelay(storage)).toBe(delay);
  });

  it("stores the delay under its key", () => {
    const storage = new FakeStorage();
    saveIdleDelay(storage, "never");
    expect(storage.items.get(IDLE_DELAY_KEY)).toBe("never");
  });

  it.each([null, "", "10", "60.0", " 60", "Never", "abc"])("falls back to the default for %j", (value) => {
    expect(parseIdleDelay(value)).toBe(DEFAULT_IDLE_DELAY);
  });

  it("parses every option value back to its delay", () => {
    expect(IDLE_DELAYS.map((delay) => parseIdleDelay(idleDelayValue(delay)))).toEqual(IDLE_DELAYS);
  });
});
